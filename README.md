# bedrock_inference_profiles

Pi extension that registers a `bedrock-profiles` provider listing your AWS Bedrock
**application inference profiles** by name (not ARN) in the `/model` selector.

## Setup

```sh
cp config.example.json config.json   # then edit
```

| key           | meaning                                                              |
|---------------|----------------------------------------------------------------------|
| `aws_profile` | AWS profile for listing and inference (falls back to `$AWS_PROFILE`) |
| `region`      | Optional; defaults to the profile's region, `$AWS_REGION`, `us-east-1` |

Requires the `aws` CLI and `bedrock:ListInferenceProfiles` + invoke permissions.

Enable it by adding this directory to `packages` in `~/.pi/agent/settings.json`, then `/reload`.
Capabilities and pricing are copied from pi's built-in Bedrock catalog for the underlying model.
