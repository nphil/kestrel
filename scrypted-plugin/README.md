# Wildlife Visits

Publishes one MQTT message when a selected Scrypted camera sees a new animal species. Repeated detections of that species on the same camera are held back for the configured cooldown.

Set the cameras, cooldown, MQTT broker and optional credentials in this plugin's Settings. Home Assistant MQTT discovery creates one Wildlife Visits device with one animal event entity per selected camera. If a detection has no species label, the event is named `Unidentified animal`.
