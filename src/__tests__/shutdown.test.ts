import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const fixture = vi.hoisted(() => ({
    child: {
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        killed: false,
        stdin: {end: vi.fn()},
        stderr: {addListener: vi.fn()},
        kill: vi.fn(),
    },
    log: vi.fn(),
    builder: {
        onConnect: vi.fn().mockReturnThis(),
        onRequest: vi.fn().mockReturnThis(),
        onNotification: vi.fn().mockReturnThis(),
        connect: vi.fn().mockReturnThis(),
    },
}));

vi.mock("../CodexJsonRpcConnection", () => ({
    startCodexConnection: vi.fn(() => ({process: fixture.child, connection: {}})),
}));
vi.mock("../Logger", () => ({logger: {log: fixture.log, error: vi.fn()}}));
vi.mock("../StdUtils", async (importOriginal) => ({
    ...await importOriginal<typeof import("../StdUtils")>(),
    createJsonStream: vi.fn(() => ({})),
}));
vi.mock("@agentclientprotocol/sdk", async (importOriginal) => ({
    ...await importOriginal<typeof import("@agentclientprotocol/sdk")>(),
    agent: vi.fn(() => fixture.builder),
}));

describe("entry-point child shutdown", () => {
    const originalArgv = process.argv;
    let close: () => void;

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.stubEnv("CODEX_CONFIG", "");
        vi.stubEnv("DEFAULT_AUTH_REQUEST", "");
        process.argv = [process.execPath, "shutdown.test"];
        fixture.child.exitCode = null;
        fixture.child.signalCode = null;
        fixture.child.killed = false;

        let captured: (() => void) | undefined;
        const originalOn = process.stdin.on;
        vi.spyOn(process.stdin, "on").mockImplementation((event, listener) => {
            if (event === "close") {
                expect(captured).toBeUndefined();
                captured = listener;
                return process.stdin;
            }
            return originalOn.call(process.stdin, event, listener);
        });
        // Register the production handler without emitting a global stdin event
        // or executing any ACP builder callback that could start an agent.
        await import("../index");
        expect(captured).toBeTypeOf("function");
        close = captured!;
        expect(fixture.builder.connect).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        fixture.log.mockClear(); // Startup logging is outside the close contract.
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        process.argv = originalArgv;
    });

    it.each([0, 1])("does not touch a child that exited with code %i before EOF", (code) => {
        fixture.child.exitCode = code;
        close();
        expect(fixture.child.stdin.end).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(2000);
        expect(fixture.log).not.toHaveBeenCalled();
        expect(fixture.child.kill).not.toHaveBeenCalled();
    });

    it.each([0, 1])("does not signal a child that exits with code %i after EOF", (code) => {
        close();
        expect(fixture.child.stdin.end).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(1999);
        fixture.child.exitCode = code;
        vi.advanceTimersByTime(1);
        expect(fixture.log).not.toHaveBeenCalled();
        expect(fixture.child.kill).not.toHaveBeenCalled();
    });

    it.each(["before", "after"])("does not resignal a child terminated %s EOF", (when) => {
        if (when === "before") fixture.child.signalCode = "SIGTERM";
        close();
        if (when === "after") fixture.child.signalCode = "SIGTERM";
        expect(fixture.child.stdin.end).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
        if (when === "before") expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(2000);
        expect(fixture.log).not.toHaveBeenCalled();
        expect(fixture.child.kill).not.toHaveBeenCalled();
    });

    it.each([false, true])("terminates a still-live child once at 2s, including killed=%s", (killed) => {
        fixture.child.killed = killed;
        close();
        expect(fixture.child.stdin.end).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(1999);
        expect(fixture.log).not.toHaveBeenCalled();
        expect(fixture.child.kill).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fixture.log).toHaveBeenCalledExactlyOnceWith(
            "Codex still running 2s after stdin closed; terminating process",
        );
        // Node's no-argument kill uses SIGTERM; killed records a request, not exit.
        expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith();
        vi.advanceTimersByTime(2000);
        expect(fixture.log).toHaveBeenCalledOnce();
        expect(fixture.child.kill).toHaveBeenCalledOnce();
    });

    it("does not keep the parent alive solely for the shutdown fallback", () => {
        const timeout = vi.spyOn(globalThis, "setTimeout");
        close();
        expect(timeout).toHaveBeenCalledOnce();
        const timer = timeout.mock.results[0]!.value as NodeJS.Timeout;
        expect(timer.hasRef()).toBe(false);
    });
});
