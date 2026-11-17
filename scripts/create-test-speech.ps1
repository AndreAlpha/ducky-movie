param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $italianVoice = $speaker.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'it-IT' } | Select-Object -First 1
    if ($italianVoice) { $speaker.SelectVoice($italianVoice.VoiceInfo.Name) }
    $speaker.SetOutputToWaveFile($Destination)
    $speaker.Speak('Oggi prepariamo un breve film. Le immagini raccontano una giornata al mare. La voce accompagna il viaggio, mentre il sole illumina la spiaggia.')
} finally { $speaker.Dispose() }
