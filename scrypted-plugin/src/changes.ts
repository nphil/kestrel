// "Say it only when it changed": remembers the last value that was published and lets a new one
// through only when it differs from it. Dependency-free on purpose: main.ts imports it, and the
// unit tests import it directly without the Scrypted SDK.
//
// The first value always passes. A process that has just started cannot know what its listeners
// last saw (Home Assistant and the dashboards may have missed anything while it was down).
export class ChangeGate {
    private last: string | undefined;

    // True, and remembers `value`, when it differs from the last value that passed. Values are
    // compared by content, so a list rebuilt from scratch on every check does not count as a change.
    changed(value: unknown): boolean {
        const next = JSON.stringify(value);
        if (next === this.last) return false;
        this.last = next;
        return true;
    }
}
