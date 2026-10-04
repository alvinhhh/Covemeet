#!/bin/sh
# Deterministic text-to-file prompts. Never opens an audio playback device.
set -eu
out=${1:?Output directory required}
mkdir -p "$out"
render() {
  name=$1
  text=$2
  espeak-ng -v en-us -s 155 -a 80 -w "/tmp/${name}.wav" "$text"
  sox -R "/tmp/${name}.wav" -r 8000 -c 1 -b 16 "$out/${name}.wav"
  rm "/tmp/${name}.wav"
}
render covemeet-code 'Enter the twelve digit phone meeting code, followed by pound.'
render covemeet-pin 'Enter the eight digit PIN, followed by pound.'
render covemeet-waiting 'Waiting for the host. You will join muted.'
render covemeet-admitted 'You have joined the meeting.'
render covemeet-muted 'Microphone muted.'
render covemeet-unmuted 'Microphone unmuted.'
render covemeet-blocked 'The host has disabled your microphone.'
render covemeet-help 'Press star six to toggle mute when permitted. Press star nine to raise or lower your hand.'
render covemeet-invalid 'Unable to join. Check the phone meeting code and PIN, then call again.'
chmod 644 "$out"/covemeet-*.wav
