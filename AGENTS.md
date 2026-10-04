# VOLPAROSSA Code

- Build on the open-source OpenCode runtime and reuse suitable upstream apps/clients/editor integrations (user revision 2026-10-02). Original integration code is GPL-3.0-only; preserve upstream MIT notices. Codex experiments are historical, not the selected runtime.
- VOLPAROSSA owns model selection, peer scheduling, cancellation and contribution accounting. Do not add a competing peer coordinator here.
- Private source, prompts, credentials, tool results and repository history must not be silently published to peers, cache or training. Public work requires explicit scope and consent.
- Network cooperation and collective improvement are the default architectural goal, including protected execution of private work on other nodes. Local inference is a fallback/development executor, not completion of that requirement. Do not replace real peer collaboration with local subagents or claim that TLS, fragmenting tasks or a peer signature protects inputs from the executing host.
- No OpenAI authentication, cloud inference fallback, telemetry, automatic runtime/model downloads or global configuration changes.
- Opening a workspace must not start models, commands or network participation. Honor editor workspace trust and explicit per-operation input selection.
- OpenCode tool actions remain subject to local workspace/approval boundaries; a model response is not authority to run a command. Core owns immune-policy decisions and executor admission; frontend labels are not an implemented immune system.
- Keep the README honest about the difference between transport tests, actual inference, native editor tests and complete coding-agent behavior.
- Use targeted checks while integrating executable slices. Preserve upstream notices and pin any reused runtime exactly.
