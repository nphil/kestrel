/** Loading this module registers Kestrel's custom Home Assistant panel and cards. */
import { defineElements, LuAppShell, LuAudioPlayer, LuButton, LuChip, LuGrid, LuImage, LuMediaRail, LuRoot, LuRow, LuSection, LuSegmented, LuSheet, LuState, LuViewStack } from "lucent-ha";
import "./components/kestrel-cameras.ts";
import "./components/kestrel-card-editors.ts";
import "./components/kestrel-highlight-card.ts";
import "./components/kestrel-species-list-card.ts";

// The toolkit's elements Kestrel uses, registered as <kestrel-lu-...>. Only these (and what they render) reach the bundle.
defineElements("kestrel", [LuAppShell, LuAudioPlayer, LuButton, LuChip, LuGrid, LuImage, LuMediaRail, LuRoot, LuRow, LuSection, LuSegmented, LuSheet, LuState, LuViewStack]);
