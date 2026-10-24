/**
 * Bedrock Inference Profiles provider.
 *
 * Lists the account's APPLICATION inference profiles and exposes each one as a model whose
 * id and name are the profile *name* (e.g. "claude-opus-4-7") rather than its ARN. Requests are
 * delegated to pi's built-in Bedrock Converse implementation with the id swapped for the ARN.
 *
 * Config: the `bedrockInferenceProfiles` key in the global pi settings (~/.pi/agent/settings.json). Keys:
 *   aws_profile  AWS profile used for listing profiles and for inference (falls back to $AWS_PROFILE; no env var needed when set)
 *   region       Optional region (falls back to the profile's region, $AWS_REGION, then us-east-1)
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	type Api,
	type AssistantMessageEventStream,
	bedrockConverseStreamApi,
	createAssistantMessageEventStream,
	getModels,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER = "bedrock-profiles";
const execFileAsync = promisify(execFile);

interface Config {
	aws_profile?: string;
	region?: string;
}

interface ProfileSummary {
	inferenceProfileName: string;
	inferenceProfileArn: string;
	status?: string;
	models?: { modelArn: string }[];
}

const here = dirname(fileURLToPath(import.meta.url));

function readJson(file: string): Record<string, unknown> {
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Invalid ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Config lives in the global pi settings (`<agentDir>/settings.json`, key "bedrockInferenceProfiles"). */
function loadConfig(): Config {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return (readJson(join(agentDir, "settings.json")).bedrockInferenceProfiles ?? {}) as Config;
}

async function aws(args: string[], profile: string | undefined, signal?: AbortSignal): Promise<string> {
	const full = profile ? [...args, "--profile", profile] : args;
	const env = profile ? { ...process.env, AWS_PROFILE: profile } : process.env;
	const { stdout } = await execFileAsync("aws", full, { signal, env, maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

async function resolveRegion(config: Config, signal?: AbortSignal): Promise<string> {
	if (config.region) return config.region;
	try {
		const region = (await aws(["configure", "get", "region"], profileOf(config), signal)).trim();
		if (region) return region;
	} catch {
		// fall through
	}
	return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
}

function profileOf(config: Config): string | undefined {
	return config.aws_profile || process.env.AWS_PROFILE || undefined;
}

// Profile name -> ARN, rebuilt on every refresh. Used by the stream function.
const arnByName = new Map<string, string>();

/** Find the built-in Bedrock catalog entry for an underlying foundation model, for capabilities and pricing. */
function findBuiltin(modelArn: string | undefined): Model<Api> | undefined {
	const baseId = modelArn?.split("foundation-model/")[1] ?? modelArn?.split("/").pop();
	if (!baseId) return undefined;
	const catalog = getModels("amazon-bedrock" as never) as Model<Api>[];
	return (
		catalog.find((m) => m.id === baseId) ??
		catalog.find((m) => m.id.endsWith(`.${baseId}`)) ??
		catalog.find((m) => m.id.replace(/^(eu|us|apac|au|global|jp|us-gov)\./, "") === baseId)
	);
}

function toModelConfig(profile: ProfileSummary, baseUrl: string): ProviderModelConfig {
	const builtin = findBuiltin(profile.models?.[0]?.modelArn);
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		id: profile.inferenceProfileName,
		name: profile.inferenceProfileName,
		api: "bedrock-converse-stream",
		baseUrl,
		reasoning: builtin?.reasoning ?? false,
		thinkingLevelMap: builtin?.thinkingLevelMap,
		input: builtin?.input ?? ["text"],
		inputLimits: builtin?.inputLimits,
		cost: builtin?.cost ?? zero,
		contextWindow: builtin?.contextWindow ?? 200000,
		maxTokens: builtin?.maxTokens ?? 8192,
	};
}

async function listModels(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const config = loadConfig();
	const profile = profileOf(config);
	const region = await resolveRegion(config, signal);
	const out = await aws(
		["bedrock", "list-inference-profiles", "--type-equals", "APPLICATION", "--region", region, "--output", "json"],
		profile,
		signal,
	);
	const summaries = ((JSON.parse(out) as { inferenceProfileSummaries?: ProfileSummary[] }).inferenceProfileSummaries ?? [])
		.filter((p) => !p.status || p.status === "ACTIVE")
		.sort((a, b) => a.inferenceProfileName.localeCompare(b.inferenceProfileName));

	const baseUrl = `https://bedrock-runtime.${region}.amazonaws.com`;
	arnByName.clear();
	for (const p of summaries) arnByName.set(p.inferenceProfileName, p.inferenceProfileArn);
	return summaries.map((p) => toModelConfig(p, baseUrl));
}

function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	});
	stream.end();
	return stream;
}

function streamProfile(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const arn = arnByName.get(model.id);
	if (!arn) return errorStream(model, `Unknown inference profile "${model.id}". Re-open /model to refresh the list.`);

	const config = loadConfig();
	const awsProfile = profileOf(config);
	const stream = createAssistantMessageEventStream();
	// Keep the friendly name in recorded messages instead of the ARN.
	const rename = (m: { model?: string } | undefined) => {
		if (m) m.model = model.id;
	};
	const inner = bedrockConverseStreamApi().streamSimple({ ...model, id: arn }, context, {
		...options,
		apiKey: undefined, // the registered key is a placeholder; auth comes from the AWS profile
		profile: awsProfile,
		// Scope AWS_PROFILE to this request so the config value is used without exporting it in the shell.
		env: awsProfile ? { ...(options as { env?: Record<string, string> } | undefined)?.env, AWS_PROFILE: awsProfile } : (options as { env?: Record<string, string> } | undefined)?.env,
		region: arn.split(":")[3] || config.region,
	} as SimpleStreamOptions);

	(async () => {
		for await (const event of inner) {
			const e = event as { partial?: { model?: string }; message?: { model?: string }; error?: { model?: string } };
			rename(e.partial);
			rename(e.message);
			rename(e.error);
			stream.push(event);
		}
		stream.end();
	})().catch((error) => {
		stream.push(errorStream(model, error instanceof Error ? error.message : String(error)) as never);
		stream.end();
	});
	return stream;
}

export default async function (pi: ExtensionAPI) {
	let models: ProviderModelConfig[] = [];
	try {
		models = await listModels();
	} catch (error) {
		console.error(`[bedrock-profiles] Could not list inference profiles: ${error instanceof Error ? error.message : error}`);
	}

	pi.registerProvider(PROVIDER, {
		name: "Bedrock Inference Profiles",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		// Credentials come from the AWS profile; the key is a placeholder required by the registration.
		apiKey: "aws-profile",
		api: "bedrock-converse-stream",
		streamSimple: streamProfile,
		models,
		refreshModels: (context) => listModels(context.signal),
	});
}
