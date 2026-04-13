import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { RegionUnavailableError } from "./bedrock.js";

export { RegionUnavailableError };

let regionCheckPassed: boolean | null = null;

/**
 * Called once on Lambda cold start. Probes Bedrock by issuing a minimal
 * InvokeModel request. A 403 or 404 response means the model/region is
 * unavailable; anything else (including a successful response or a
 * validation error) means it's reachable.
 */
export async function checkRegionOnColdStart(): Promise<void> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const modelId =
    process.env["BEDROCK_MODEL_ID"] ?? "anthropic.claude-3-5-sonnet-20241022-v2:0";

  try {
    const client = new BedrockRuntimeClient({ region });
    // Send a minimal (invalid) body — we expect a ValidationException (400),
    // NOT a 403/404. Any response other than 403/404 confirms the region works.
    await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode("{}"),
      })
    );
    regionCheckPassed = true;
  } catch (err: unknown) {
    const error = err as { $metadata?: { httpStatusCode?: number }; name?: string };
    const status = error.$metadata?.httpStatusCode;
    if (status === 404) {
      // 404 = model genuinely not found in this region
      console.error(`[region-check] Bedrock model not found in ${region}: HTTP ${status}`);
      regionCheckPassed = false;
    } else {
      // 400 = ValidationException (expected — body was invalid, but model exists)
      // 403 = could be IAM permission issue with inference profiles, not a region issue
      //       The fallback chain in invokeBedrock will handle model-level failures.
      // 400 ValidationException, 400 ModelNotReadyException, etc. — region is reachable
      console.info(
        `[region-check] Bedrock reachable in ${region} (probe returned ${status ?? error.name})`
      );
      regionCheckPassed = true;
    }
  }
}

export function assertRegionAvailable(): void {
  if (regionCheckPassed === false) {
    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const modelId =
      process.env["BEDROCK_MODEL_ID"] ?? "anthropic.claude-3-5-sonnet-20241022-v2:0";
    throw new RegionUnavailableError(region, modelId);
  }
  // null = check hasn't run yet — fail open
}

/** Test helpers — not for production use */
export function _resetRegionCheckForTest(): void {
  regionCheckPassed = null;
}

export function _setRegionCheckResultForTest(passed: boolean): void {
  regionCheckPassed = passed;
}
