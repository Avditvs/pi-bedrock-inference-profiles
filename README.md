# bedrock_inference_profiles

Pi extension that registers a `bedrock-profiles` provider listing your AWS Bedrock
**application inference profiles** by name (not ARN) in the `/model` selector.

## Setup

1. Add this directory to `packages` in `~/.pi/agent/settings.json`, then `/reload`.
2. Add the config to the same file:

```json
"bedrockInferenceProfiles": { "aws_profile": "my-aws-profile", "region": "eu-west-1" }
```

| key           | meaning                                                                |
|---------------|------------------------------------------------------------------------|
| `aws_profile` | AWS profile for listing and inference (falls back to `$AWS_PROFILE`)   |
| `region`      | Optional; defaults to the profile's region, `$AWS_REGION`, `us-east-1` |

Config is read only from the global pi settings (no `config.json` fallback).

Requires the `aws` CLI and `bedrock:ListInferenceProfiles` + invoke permissions.

## How it works

- **Listing**: runs `aws bedrock list-inference-profiles --type-equals APPLICATION`, keeps
  `ACTIVE` profiles, sorts by name and keeps a name -> ARN map. The list is refreshed
  whenever `/model` is reopened (`refreshModels`).
- **Model metadata**: capabilities (reasoning, input types, limits), pricing, context window and
  max tokens are copied from pi's built-in `amazon-bedrock` catalog for the underlying
  foundation model. Fallback: text only, zero cost, 200k context, 8192 max tokens.
- **Inference**: delegates to pi's built-in Bedrock Converse stream with the model id replaced by
  the profile ARN. Auth uses the AWS profile (`AWS_PROFILE` scoped to the request); the region is
  taken from the ARN. Recorded messages keep the friendly profile name.
- **Errors**: unknown profile -> error asking to reopen `/model`; if listing fails at startup the
  provider registers with no models and logs the error.
