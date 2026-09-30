# VOLPAROSSA Code

- Build an independent GPL-3.0-only editor extension on the open Codex CLI/app-server, not a copy of the proprietary OpenAI IDE extension.
- VOLPAROSSA owns model selection, peer scheduling, cancellation and contribution accounting. Do not add a competing peer coordinator here.
- Private source, prompts, credentials, tool results and repository history must not be silently published to peers, cache or training. Public work requires explicit scope and consent.
- No OpenAI authentication, cloud inference fallback, telemetry, automatic runtime/model downloads or global configuration changes.
- Opening a workspace must not start models, commands or network participation. Honor editor workspace trust and explicit per-operation input selection.
- Codex tool actions remain subject to local workspace/approval boundaries; a model response is not authority to run a command.
- Keep the README honest about the difference between transport tests, actual inference, native editor tests and complete coding-agent behavior.
- Use targeted checks while integrating executable slices. Preserve upstream notices and pin any reused runtime exactly.

