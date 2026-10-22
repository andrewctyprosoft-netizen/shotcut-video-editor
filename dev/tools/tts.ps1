# Speak a text file to a 16 kHz mono WAV with the built-in Windows voice (System.Speech).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tts.ps1 <text.txt> <out.wav>
param([string]$TextFile, [string]$OutFile)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($OutFile, $format)
$synth.Speak([System.IO.File]::ReadAllText($TextFile))
$synth.Dispose()
