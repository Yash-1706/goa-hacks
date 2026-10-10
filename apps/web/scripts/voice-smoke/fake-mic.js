// Paste into the browser console of the Synapse page BEFORE tapping the orb. It replaces the microphone with a stream that plays
// the synthetic-voice WAVs (see make-speech.ps1) over a faint room noise, so the real VAD, the real packetizer and the real
// Wispr streamer run exactly as they do with a person talking. Dev tool: nothing here ships with the app.
//
//   __fakeMic.say(1)                      speak sentence 1 (3.2 s)
//   __fakeMic.say(2)                      speak sentence 2 (6.3 s)
//   __fakeMic.say(1, { gain: 0.03 })      the same at about -30 dBFS, like a whisper
//   __fakeMic.say(1, { delay: 2 })        start in 2 s
(async () => {
  const ac = new AudioContext({ sampleRate: 48000 }); // like a real mic; the app resamples to 16 kHz
  const dest = ac.createMediaStreamDestination();
  const load = async (name) => ac.decodeAudioData(await (await fetch(`/_dev/${name}.wav`)).arrayBuffer());
  const clips = { 1: await load("utt1"), 2: await load("utt2") };

  // a real microphone is never digital silence: give the VAD's noise-floor calibration something to measure
  const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.003;
  const floor = ac.createBufferSource();
  floor.buffer = noise;
  floor.loop = true;
  floor.connect(dest);
  floor.start();

  const mic = {
    ac,
    dest,
    calls: [],
    /** returns the length of the sentence in seconds */
    say(n, { gain = 1, delay = 0.3 } = {}) {
      const src = ac.createBufferSource();
      src.buffer = clips[n];
      const g = ac.createGain();
      g.gain.value = gain;
      src.connect(g).connect(dest);
      src.start(ac.currentTime + delay);
      return clips[n].duration;
    },
  };
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    mic.calls.push(JSON.stringify(constraints));
    await ac.resume(); // runs inside the tap on the orb, so the browser allows it
    return dest.stream;
  };
  window.__fakeMic = mic;
  console.log("fake mic ready: tap the orb, then __fakeMic.say(1)");
})();
