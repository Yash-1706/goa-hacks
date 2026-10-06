import type { ClientMessage, ServerMessage } from "@synapse/shared";
import { setDisplayTimezone } from "@/lib/format";
import { LatencyTracker, afterPaint as realAfterPaint } from "@/lib/latency";
import { useAudioUi } from "@/state/audio";
import { useConnection } from "@/state/connection";
import { useCalendar, useDevices } from "@/state/devices";
import { useGraph } from "@/state/graph";
import { useMetrics } from "@/state/metrics";
import { useNotices } from "@/state/notices";
import { useOutbox } from "@/state/outbox";
import { usePrivacy } from "@/state/privacy";
import { useRecall } from "@/state/recall";
import { useSettings } from "@/state/settings";
import { useStream } from "@/state/stream";
import { useSuggestions } from "@/state/suggestions";
import { useThoughts } from "@/state/thoughts";

/* ============================================================================
 * ServerMessage → store updates. One function, one switch: every message type has exactly one place
 * where it lands. Side effects that are not state (stopping the mic, timers, metrics) go through `deps`,
 * which is what makes this file unit-testable.
 * ========================================================================== */

export interface HandlerDeps {
  send: (msg: ClientMessage) => boolean;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  afterPaint: (cb: () => void) => void;
  /** the server paused memory (any device, or its own semantic backstop): release the mic */
  onRemotePause: () => void;
  /** the server resumed memory: do NOT restart the mic (resume is a deliberate tap) */
  onRemoteResume: () => void;
}

export const REMOVAL_ANIMATION_MS = 1500;
export const RESOLVED_SUGGESTION_MS = 1800;

const RESOLVED = new Set(["accepted", "dismissed", "later", "expired"]);

export interface Handlers {
  handle: (msg: ServerMessage) => void;
  tracker: LatencyTracker;
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const tracker = new LatencyTracker({
    send: deps.send,
    now: deps.now,
    afterPaint: deps.afterPaint,
    onFirstPaint: (f, t, ms, at) => useMetrics.getState().recordFirstPaint(f, t, ms, at),
    onArtifact: (f, t, ms, at) => useMetrics.getState().recordArtifact(f, t, ms, at),
  });

  const handle = (msg: ServerMessage): void => {
    const now = deps.now();
    switch (msg.type) {
      case "welcome": {
        const { config, state } = msg;
        useSettings.getState().setConfig(config);
        setDisplayTimezone(config.timezone);
        useThoughts.getState().hydrate(state.thoughts);
        useSuggestions.getState().hydrate(state.suggestions, state.echoes);
        useStream.getState().setAsideCount(state.asideCount);
        usePrivacy.getState().hydrate(state);
        useDevices.getState().set(state.devices);
        useMetrics.getState().setSummary(state.metrics);
        useCalendar.getState().set(state.calendar);
        useConnection.getState().set({ deviceId: msg.deviceId, welcomeAt: now });
        return;
      }

      case "state.update":
        usePrivacy.getState().hydrate({ paused: msg.paused, pausedAt: msg.pausedAt, pausedBy: msg.pausedBy });
        useDevices.getState().set(msg.devices);
        return;

      case "wispr.context":
        useAudioUi.getState().set({ wisprContext: { dictionary: msg.dictionary, conversation: msg.conversation, language: msg.language } });
        return;

      case "fragment.ack":
        useThoughts.getState().noteAck(msg.fragmentId, msg.thoughtId);
        tracker.onAck(msg.fragmentId, msg.thoughtId);
        return;

      case "fragment.filtered":
        useStream.getState().filtered(msg.fragmentId, msg.asideCount, msg.reason, now);
        return;

      case "thought.upsert": {
        useThoughts.getState().upsert(msg.thought);
        useStream.getState().absorb(msg.thought.fragments.map((f) => f.id));
        tracker.onUpsert(msg.thought);
        return;
      }

      case "thought.remove": {
        if (msg.reason === "aside") {
          // the local draft turned out to be a side remark: let what YOU said dissolve into the counter
          const t = useThoughts.getState().byId[msg.id];
          if (t) useStream.getState().ghostify(t.fragments, now);
        }
        const animated = useThoughts.getState().remove(msg.id, msg.reason);
        tracker.forget(msg.id);
        if (animated) deps.schedule(() => useThoughts.getState().finishRemoval(msg.id), REMOVAL_ANIMATION_MS);
        return;
      }

      case "artifact.upsert": {
        useThoughts.getState().setArtifact(msg.thoughtId, msg.artifact);
        const t = useThoughts.getState().byId[msg.thoughtId];
        useOutbox.getState().patch(msg.thoughtId, msg.artifact, { thoughtCode: t?.code, thoughtTitle: t?.title });
        return;
      }

      case "suggestion.push":
        useSuggestions.getState().push(msg.suggestion, now);
        return;

      case "suggestion.update": {
        useSuggestions.getState().update(msg.id, msg.status);
        if (RESOLVED.has(msg.status)) deps.schedule(() => useSuggestions.getState().finish(msg.id), RESOLVED_SUGGESTION_MS);
        return;
      }

      case "echo.push":
        useSuggestions.getState().pushEcho(msg.echo, now);
        return;

      case "recall.sources":
        useRecall.getState().sources(msg, now);
        return;

      case "recall.delta":
        useRecall.getState().delta(msg.queryId, msg.text, now);
        return;

      case "recall.done":
        useRecall.getState().done(msg, now);
        return;

      case "graph.delta":
        useGraph.getState().applyDelta(msg);
        return;

      case "brief.ready":
        useSuggestions.getState().pushBrief(msg.brief, now);
        return;

      case "privacy.paused":
        usePrivacy.getState().paused_({ by: msg.by, purgedCount: msg.purgedCount, at: msg.at });
        deps.onRemotePause();
        return;

      case "privacy.resumed":
        usePrivacy.getState().resumed();
        deps.onRemoteResume();
        return;

      case "privacy.forgot":
        usePrivacy.getState().forgot({ scope: msg.scope, count: msg.count, query: msg.query, at: msg.at });
        return;

      case "notice":
        useNotices.getState().push(msg.level, msg.text, { now });
        return;

      case "metrics.update":
        useMetrics.getState().setSummary(msg.summary);
        return;

      case "calendar.update":
        useCalendar.getState().set(msg.events);
        return;

      case "error": {
        const text = msg.code === "handler_failed" ? `The server could not process “${msg.message}”.` : msg.message || `Server error (${msg.code})`;
        useNotices.getState().push("warn", text, { now });
        return;
      }

      // handled by the socket itself (clock sync, token waiters, auth)
      case "pong":
      case "auth.required":
      case "wispr.token":
        return;
    }
  };

  return { handle, tracker };
}

export { realAfterPaint };
