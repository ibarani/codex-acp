import {afterEach, describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestModel} from "../acp-test-utils";
import type {ReasoningEffort} from "../../app-server";
import type {Model, Thread, ThreadStartResponse} from "../../app-server/v2";

const sessionId = "current-model-session";
const cwd = "/test/current-model-selection";
const entrypoints = ["new", "load", "resume"] as const;
type Entrypoint = typeof entrypoints[number];

afterEach(() => vi.restoreAllMocks());

function catalog(): Model[] {
    return [
        createTestModel({
            id: "alpha", displayName: "Alpha", description: "First model",
            supportedReasoningEfforts: [
                {reasoningEffort: "low", description: "Quick"},
                {reasoningEffort: "high", description: "Thorough"},
            ],
            defaultReasoningEffort: "high", inputModalities: ["text"],
        }),
        createTestModel({
            id: "beta", displayName: "Beta", description: "Second model",
            supportedReasoningEfforts: [{reasoningEffort: "medium", description: "Balanced"}],
            isDefault: false,
        }),
    ];
}

const catalogEntries = [
    {modelId: "alpha[low]", name: "Alpha (low)", description: "First model Quick"},
    {modelId: "alpha[high]", name: "Alpha (high)", description: "First model Thorough"},
    {modelId: "beta[medium]", name: "Beta (medium)", description: "Second model Balanced"},
];

// Keep both ACP layers real. Only the native RPC boundary is mocked; this fixture
// never starts the bundled native executable used by createTestFixture().
function nativeSession(models: Model[], model: string, reasoningEffort: ReasoningEffort | null) {
    const fixture = createCodexMockTestFixture();
    const agent = fixture.getCodexAcpAgent();
    const client = fixture.getCodexAcpClient();
    const native = fixture.getCodexAppServerClient();
    const thread: Thread = {
        id: sessionId, sessionId, parentThreadId: null, forkedFromId: null,
        threadSource: null, preview: "", ephemeral: false, section: null,
        sectionEnteredAt: null, modelProvider: "custom-provider", createdAt: 1,
        updatedAt: 1, recencyAt: null, status: {type: "idle"}, path: null,
        cwd, cliVersion: "test", source: "cli", agentNickname: null,
        agentRole: null, gitInfo: null, name: null, turns: [],
    };
    const response: ThreadStartResponse = {
        thread, model, reasoningEffort, modelProvider: "custom-provider",
        serviceTier: null, cwd, instructionSources: [], approvalPolicy: "never",
        approvalsReviewer: "user", sandbox: {type: "readOnly", networkAccess: false},
    };
    vi.spyOn(client, "authRequired").mockResolvedValue(false);
    vi.spyOn(client, "getCurrentModelProvider").mockResolvedValue("custom-provider");
    vi.spyOn(native, "threadStart").mockResolvedValue(response);
    vi.spyOn(native, "threadResume").mockResolvedValue(response);
    vi.spyOn(native, "threadRead").mockResolvedValue({thread});
    vi.spyOn(native, "threadGoalGet").mockResolvedValue({goal: null});
    vi.spyOn(native, "skillsExtraRootsSet").mockResolvedValue(undefined);
    vi.spyOn(native, "listSkills").mockResolvedValue({data: []});
    const listModels = vi.spyOn(native, "listModels").mockResolvedValue({data: models, nextCursor: null});

    function open(entrypoint: Entrypoint) {
        switch (entrypoint) {
            case "new": return agent.newSession({cwd, mcpServers: []});
            case "load": return agent.loadSession({sessionId, cwd, mcpServers: []});
            case "resume": return agent.resumeSession({sessionId, cwd, mcpServers: []});
        }
    }
    return {agent, client, native, listModels, open};
}

describe.each(entrypoints)("%s current model", (entrypoint) => {
    it.each([
        {label: "uncataloged base", model: "custom-model", effort: "max" as const},
        {label: "unadvertised current effort", model: "alpha", effort: "max" as const},
        {label: "already advertised tuple", model: "alpha", effort: "low" as const},
    ])("includes $label once without changing catalog entries or capabilities", async ({model, effort}) => {
        const models = catalog();
        const {agent, listModels, open} = nativeSession(models, model, effort);
        const response = await open(entrypoint);
        const currentModelId = `${model}[${effort}]`;
        const picker = response.models;
        expect(picker?.currentModelId).toBe(currentModelId);
        expect(picker?.availableModels.filter(entry => entry.modelId === currentModelId)).toHaveLength(1);
        const advertised = catalogEntries.some(entry => entry.modelId === currentModelId);
        expect(picker?.availableModels).toEqual(advertised ? catalogEntries : [
            {modelId: currentModelId, name: currentModelId, description: null}, ...catalogEntries,
        ]);
        expect(listModels).toHaveBeenCalledExactlyOnceWith({cursor: null, limit: null});
        const state = agent.getSessionState(sessionId);
        expect(state.availableModels).toEqual(models);
        expect(state.supportedReasoningEfforts).toEqual(model === "alpha" ? models[0]!.supportedReasoningEfforts : []);
        expect(state.supportedInputModalities).toEqual(model === "alpha" ? ["text"] : ["text", "image"]);
        expect(state.currentModelSupportsFast).toBe(false);
    });

    it("keeps only the resolved tuple for a model with no advertised efforts", async () => {
        const models = [createTestModel({id: "empty-efforts", supportedReasoningEfforts: []}), ...catalog()];
        const {agent, open} = nativeSession(models, "empty-efforts", "high");
        const response = await open(entrypoint);
        expect(response.models).toEqual({
            currentModelId: "empty-efforts[high]",
            availableModels: [
                {modelId: "empty-efforts[high]", name: "empty-efforts[high]", description: null},
                ...catalogEntries,
            ],
        });
        expect(agent.getSessionState(sessionId).supportedReasoningEfforts).toEqual([]);
        expect(agent.getSessionState(sessionId).availableModels).toEqual(models);
    });

    it("accepts a native explicit model and effort with an empty catalog", async () => {
        const {agent, open} = nativeSession([], "custom-model", "max");
        const response = await open(entrypoint);
        expect(response.models).toEqual({
            currentModelId: "custom-model[max]",
            availableModels: [{modelId: "custom-model[max]", name: "custom-model[max]", description: null}],
        });
        expect(agent.getSessionState(sessionId).availableModels).toEqual([]);
        expect(agent.getSessionState(sessionId).supportedReasoningEfforts).toEqual([]);
    });

    it.each([
        {model: "alpha", expected: "alpha[high]"},
        {model: "custom-model", expected: "custom-model[medium]"},
        {model: "", expected: "alpha[high]"},
    ])("retains the existing null-effort resolver for '$model'", async ({model, expected}) => {
        const {open} = nativeSession(catalog(), model, null);
        const response = await open(entrypoint);
        expect(response.models?.currentModelId).toBe(expected);
        expect(response.models?.availableModels.filter(entry => entry.modelId === expected)).toHaveLength(1);
    });

    it.each(["empty", "no default"])("rejects absent native model with %s catalog", async (kind) => {
        const models = kind === "empty" ? [] : catalog().map(model => ({...model, isDefault: false}));
        const {open} = nativeSession(models, "", null);
        await expect(open(entrypoint)).rejects.toThrow();
    });
});

describe("legacy current-model selection", () => {
    it.each([
        {model: "custom-model", models: catalog()},
        {model: "alpha", models: catalog()},
        {model: "empty-efforts", models: [createTestModel({id: "empty-efforts", supportedReasoningEfforts: []})]},
    ])("refreshes the catalog before accepting unadvertised current $model without mutation", async ({model, models}) => {
        const {agent, listModels, open} = nativeSession(models, model, "max");
        await open("new");
        const state = agent.getSessionState(sessionId);
        const before = {...state, availableModels: structuredClone(state.availableModels)};
        const originalCatalog = state.availableModels;
        const refreshed = [
            ...models.map(entry => ({...entry, description: "Fresh catalog description"})),
            createTestModel({id: "replacement"}),
        ];
        listModels.mockClear().mockResolvedValue({data: refreshed, nextCursor: null});

        await expect(agent.unstable_setSessionModel({sessionId, modelId: `${model}[max]`})).resolves.toEqual({});

        expect(listModels).toHaveBeenCalledExactlyOnceWith({cursor: null, limit: null});
        expect(agent.getSessionState(sessionId)).toBe(state);
        expect(state).toEqual(before);
        expect(state.availableModels).toBe(originalCatalog);
    });

    it("does not bypass a fresh-catalog failure for the exact current tuple", async () => {
        const {agent, listModels, open} = nativeSession(catalog(), "custom-model", "max");
        await open("new");
        const state = agent.getSessionState(sessionId);
        const before = {...state};
        const failure = new Error("catalog unavailable");
        listModels.mockClear().mockRejectedValue(failure);
        await expect(agent.unstable_setSessionModel({sessionId, modelId: "custom-model[max]"})).rejects.toBe(failure);
        expect(listModels).toHaveBeenCalledTimes(1);
        expect(state).toEqual(before);
    });

    it.each([
        {modelId: "other-model[max]", message: "Unknown model", fetched: true},
        {modelId: "alpha[max]", message: "Unsupported reasoning effort", fetched: true},
        {modelId: "custom-model[high]", message: "Unknown model", fetched: true},
        {modelId: "custom-model", message: "Unsupported format", fetched: false},
        {modelId: "custom-model[]", message: "Unsupported format", fetched: false},
        {modelId: "custom-model[max", message: "Unsupported format", fetched: false},
    ])("rejects $modelId without changing the current selection", async ({modelId, message, fetched}) => {
        const {agent, listModels, open} = nativeSession(catalog(), "custom-model", "max");
        await open("new");
        const state = agent.getSessionState(sessionId);
        const before = {...state};
        listModels.mockClear();
        await expect(agent.unstable_setSessionModel({sessionId, modelId})).rejects.toThrow(message);
        expect(listModels).toHaveBeenCalledTimes(fetched ? 1 : 0);
        expect(state).toEqual(before);
    });

    it.each(["alpha[low]", "beta[medium]"])("refreshes capabilities for valid selection %s", async (modelId) => {
        const {agent, listModels, open} = nativeSession(catalog(), "alpha", "low");
        await open("new");
        const state = agent.getSessionState(sessionId);
        expect(state.currentModelSupportsFast).toBe(false);
        expect(state.supportedInputModalities).toEqual(["text"]);
        state.fastModeEnabled = true;
        const refreshed = catalog().map((model): Model => ({
            ...model, inputModalities: ["text", "image"],
            additionalSpeedTiers: ["fast"],
            supportedReasoningEfforts: [...model.supportedReasoningEfforts, {reasoningEffort: "xhigh" as const, description: "Extra"}],
        }));
        listModels.mockClear().mockResolvedValue({data: refreshed, nextCursor: null});

        await expect(agent.unstable_setSessionModel({sessionId, modelId})).resolves.toEqual({});

        expect(listModels).toHaveBeenCalledTimes(1);
        expect(state.currentModelId).toBe(modelId);
        expect(state.availableModels).toEqual(refreshed);
        expect(state.supportedReasoningEfforts).toEqual(refreshed.find(model => modelId.startsWith(`${model.id}[`))!.supportedReasoningEfforts);
        expect(state.supportedInputModalities).toEqual(["text", "image"]);
        expect(state.currentModelSupportsFast).toBe(true);
        expect(state.fastModeEnabled).toBe(true);
    });
});
