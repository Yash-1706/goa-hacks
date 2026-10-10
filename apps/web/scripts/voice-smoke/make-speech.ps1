<#
  Generates two synthetic-voice WAVs (Windows SAPI, 16 kHz mono) for the browser voice smoke test, into apps/web/public/_dev/.
  It is a computer voice, not a recording of anyone. *.wav is git-ignored; remove the files again with:  .\make-speech.ps1 -Clean
  (delete them before `pnpm build` too: whatever is in public/ ships.)
#>
param([switch]$Clean)

$dir = Join-Path $PSScriptRoot "..\..\public\_dev"
if ($Clean) {
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  Write-Host "removed $dir"
  return
}

Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $dir | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$lines = [ordered]@{
  "utt1.wav" = "Remind me to email the team about the delay."
  "utt2.wav" = "That bug from yesterday, the null pointer in the cart service, probably the discount code."
}
foreach ($name in $lines.Keys) {
  $synth.SetOutputToWaveFile((Join-Path $dir $name), $fmt)
  $synth.Speak($lines[$name])
  $synth.SetOutputToNull()
}
$synth.Dispose()
Get-ChildItem $dir | Select-Object Name, Length
