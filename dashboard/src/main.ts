/** Loading this module registers Kestrel's custom Home Assistant panel and card. */
import { defineElements, LuAppShell, LuAudioList, LuAudioPlayer, LuButton, LuChip, LuGrid, LuImage, LuMediaRail, LuRoot, LuRow, LuSection, LuSegmented, LuSheet, LuState, LuViewStack } from "lucent-ha";
import "./components/kestrel-cameras.ts";

// The toolkit's elements Kestrel uses, registered as <kestrel-lu-...>. Only these (and what they render) reach the bundle.
defineElements("kestrel", [LuAppShell, LuAudioList, LuAudioPlayer, LuButton, LuChip, LuGrid, LuImage, LuMediaRail, LuRoot, LuRow, LuSection, LuSegmented, LuSheet, LuState, LuViewStack]);
