---
name: apic
description: Run, write and test HTTP API requests with apic, the command-line runner for `.http` files. Use this whenever a project has `.http` or `.rest` files, an `apic.yaml` or an `http-client.env.json`, or the user wants to call, probe or smoke-test an HTTP API, log in and reuse the token in later calls, add a request or an assertion to an API collection, or run Gherkin `.feature` files against an API, even when they do not name apic and would otherwise reach for curl.
---

# apic

The requests live in the project's `.http` files, the same files VS Code
and JetBrains open. Every command works without a terminal, takes `--json`,
and has exit codes you can branch on, so prefer it to curl whenever a
request already exists: it resolves the variables, applies the auth, and
remembers what earlier requests captured. Run `apic version` to check it is
installed; the project is the directory holding `apic.yaml` or the `.http`
files, so `cd` there or pass `-C <dir>` on every command.

## Running requests

Work in this order, because each step tells you what the next one needs:

```sh
apic validate --json                 # every file parses; fix diagnostics before sending anything
apic list --json                     # ids, methods, URL templates, descriptions
apic describe <id> --json            # the variables it needs, where each comes from, "ready"
apic run <id> --json                 # one JSON object; exit 0 ok, 1 an assertion failed
apic run <id> --body-only            # just the response body, for piping to jq
apic run <file>.http --json          # the file in order as a flow, one object per line
apic run <id> --dry-run --json       # the resolved request, sent nowhere: look before a PUT or DELETE
apic run <id> --json --body-limit 8k # a bounded body (body_truncated: true); the whole response is kept
apic select <id> body.$.items[3].id  # any part of the last response, without sending it again
```

Add `--body-limit` when a response may be large: the result stays small
and `apic select` reads the rest from the recorded response, so one
request serves as many looks as you need (it needs `history: N` in
`apic.yaml`, which `apic init` sets; the error says so when it is off).

`describe` says which request captures a missing variable (`captured_by`),
so run that one rather than inventing a value. Captures persist in
`.apic/session.json` per environment: log in once, and later calls (in a
later shell, or a later tool call) find `{{token}}`. A request that declares
`# @ref login` runs `login` itself when the token is missing, and the run
then prints `login`'s object before its own.

Override and select with flags, not by editing files:

- `--var name=value` wins over everything; `APIC_VAR_name` in the shell is next
- `--env staging` picks an environment from `http-client.env.json`; `apic env` lists them with the variables in effect, secrets masked
- `apic session clear` when a stale captured value is winning (`describe` shows the winning source)
- `--keep-going` to run a whole flow past a failure; `--timeout 60s` for a slow API
- several targets run in order in one command: `apic run login whoami --json`

Do not read or print `http-client.private.env.json`, `.env` or
`.apic/session.json`: `describe` and `apic env` already say where each
value comes from, with secrets masked, which is all a task needs.

Read the result, not the terminal output:

```json
{"ok": true,
 "request":  {"name": "whoami", "method": "GET", "url": "https://api.example.com/me", "headers": {"Authorization": "***"}},
 "response": {"status": 200, "headers": {"content-type": "application/json"}, "body": {"email": "a@b.c"}, "duration_ms": 41},
 "captures": {"token": "eyJhbGci"},
 "asserts":  [{"expr": "status == 200", "pass": true, "actual": "200", "expected": "200"}],
 "errors":   []}
```

`response.body` is parsed JSON when the response is JSON, so chain values
without string handling. Sensitive request headers are masked, but the URL,
body and captures are real values. Add `--redact` only when the output is
going into a stored log: it masks bodies and captures too, so a redacted run
is not one to chain from.

## When a command fails

Branch on the error code, never on the message, whose wording may change:

| Exit | Where | Do |
|---|---|---|
| `1` | `ok: false`, `asserts[].pass` | an assertion or capture failed: report the `actual` against the `expected` |
| `2` | stderr `{"error": {"code", "message", "hint", …}}` | E101 missing variable: run the request named in the hint, or pass `--var`. E201 unknown request and E204 unknown environment: retry with the first of `suggestions` if the object has it, else `apic list` or `apic env`. E103 file has errors: `apic validate` |
| `3` | the same object, codes E300 to E305 | follow the `hint`. E301 could not connect and E303 TLS failed: the server is down or untrusted, so tell the user rather than retrying. E302 timed out: once with a longer `--timeout`, then tell the user. E304 protocol problem and E300 anything else: report the message. E305 cancelled: run the command again |

https://apic.sh/errors/ explains every code.

## Writing or changing requests

The format is plain text, so add requests in the same files, in the
project's style. A request is a `###` separator (its title is the
description), directives as `# @` comments, the request line, headers, a
blank line, then the body:

```http
### Create a user
# @name create-user
# @assert status == 201
# @capture userId = body.$.id
POST {{baseUrl}}/users
Content-Type: application/json

{"name": "{{name}}"}
```

- Give every request a `# @name` in kebab-case: it is the id for `run`, `describe`, MCP and features.
- Put at least `# @assert status == 200` on each one, so a flow fails on a regression rather than printing it.
- Capture what later requests need (`# @capture token = body.$.access_token`) and refer to it as `{{token}}`; add `# @ref login` to the dependants so each works on its own.
- Hosts and public settings go in `http-client.env.json` under an environment name; secrets go in `http-client.private.env.json`, which is gitignored, or come in as `APIC_VAR_name`. Never write a token or password into a `.http` file or the public env file.
- Keep to standard `.http` syntax plus `# @` directives, so the file still opens in VS Code and JetBrains; unknown directives are warnings from `apic validate`, not features.
- Try a check or a selector before writing it: `apic run <id> --assert 'body.$.items.# >= 1'` and `--capture id=body.$.id` apply for that run only, so you need no probe file and no extra calls to the API.
- Afterwards run `apic validate --json`, then `apic fmt <file>.http#<id>` to format your request without touching the rest of the file, then `apic run <id> --json` to prove it.

`apic import openapi.yaml`, `apic import collection.postman.json` and
`apic import --curl '<command>' --into file.http` write requests from what
already exists; use them before writing many by hand. `apic mock openapi.yaml
--port 8090` serves the same document's responses on localhost, so the
imported requests run with `--var baseUrl=http://localhost:8090` before the
API exists (a `Prefer: code=404` header line asks for that documented
response). `apic curl <id>` and `apic snippet <id> --lang python` show a
request to someone without apic.

Read [references/cheatsheet.md](references/cheatsheet.md) for every
directive, selector, assertion operator, built-in placeholder and the
variable precedence order; it is the full reference, so read it when writing
anything beyond the shape above.

## Testing an API

`apic test --json` runs the `.feature` files under `features/` with a
built-in step vocabulary (`When I run "get-user"`, `Then the response body
"$.name" is "alice"`). `apic test --steps` lists every phrase available in
the project, including the ones requests add with `# @step a user named
{name} exists`; write scenarios from that list rather than inventing
wording. `--tags @smoke` selects scenarios; `--format junit --output
report.xml` is for CI.

## Over MCP instead of the shell

When an MCP server for the project is registered (`claude mcp add api --
apic mcp --dir ./api --env dev`), its tools `list_requests`,
`describe_request`, `run_request`, `run_file`, `validate_project`,
`run_features`, `list_environments`, `clear_session` and `curl_request`
return the same JSON as the commands above, and each `.http` file is a
resource. Prefer them to the shell when they exist. `apic ui` is the one
interactive command; never run it from an agent.
