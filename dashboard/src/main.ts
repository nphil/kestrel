/** Loading this module registers Kestrel's custom Home Assistant panel and card. */
import { defineElements, LuAudioList, LuAudioPlayer, LuMediaRail, LuSection, LuSegmented } from "lucent-ha";
import "./ui/lazy-image.ts";
import "./components/kestrel-cameras.ts";

// The toolkit's elements Kestrel uses, registered as <kestrel-lu-...>. Only these (and what they render) reach the bundle.
defineElements("kestrel", [LuAudioList, LuAudioPlayer, LuMediaRail, LuSection, LuSegmented]);
