# dshana — the card, the theme, the directory picker

Read this when the DSHana card, theme following, or the workspace directory picker needs attention.

## DSHana card: the three states

The shell page polls `GET /api/apps/dshana/routes/dshana/boot-state` and renders by `phase`:

| State | What you see | What to do |
|---|---|---|
| Not started (`idle`) | Only one line on the surface: 「DSH 未启动」 ("DSH not started") | Opening this card issues one more start request; you can also wait for the automatic chain |
| Starting (`starting`) | A thin ring plus 「正在启动 DSH…」 ("starting DSH…") | Just wait (the first one includes the DSH boot) |
| Ready (`ready`) | The page loads the DSH Web UI | Use it |
| Needs attention (`error` / `stopped`) | A status line plus a `<pre>` block (code / message / note / runtimeId / port) | Read the `<pre>` to locate the fault; the automatic chain retries with backoff and switches ports when one is occupied |

**Where state is read from**: `boot-state` (used by both the shell page and the agent; carries phase/error/userText). The App side writes no file logs — logs always go through the host's `ctx.logger`, and managed-subprocess output is captured by the host run log.

## One session card, two mount states

Both `open` and `reply` receipts carry a `details.card` (distinguished by `act=` on the route, always titled `DSHana`), served from `ui/stream.html`.

- **In the chat stream** it draws only an entry row (the small heading for `act`, plus a three-line coordinate block: directory / session / task). It does not inject DSH and carries no ticket, so it neither stacks nor freezes.
- **Taken out of the stream** (the chat card's top-right menu / dragging — a host gesture that does not go through App code) onto the blackboard or into a detached window, the host mounts the same route on the new mount, and only then does the page assemble the relay and inject the full DSH scene.

The App does not declare a manifest card and does not call `hana.cards.open` — the card center takes no slot, and session history belongs to DSH's own sidebar (open the DSH UI to browse it); the App keeps no separate list.

**A card can pin a session**: a card route carrying `?sid=<DSH session id>` pins that session; a card without `sid` (for example one taken out of an entry row and then hand-edited) follows the current selection shared across faces.

## Theme

Host colours are followed only while the DSH theme preference is **system** (injected through the `@dshana/dsh-theme` sub-plugin); when light/dark is chosen explicitly inside DSH, DSH's own theme is used entirely and host colours do not intervene. The label for this option in DSH Appearance is **「跟随宿主」** ("follow the host") — upstream's original wording is 「跟随系统」 ("follow the system"); the preference value is still `system`, only the wording was changed to match our form.

**Which faces always follow the host is configurable.** The App settings page has a 「主题」 section with one switch per face, defaulting to the sidebar face alone (that face sits entirely inside the host frame, so its own light/dark would clash with its surroundings). Being on that list means two things at once — always follow the host (ignoring DSH's own light/dark preference) and emit the override with `!important` so element- and attribute-level requests cannot rewrite it; being off the list means following only while the preference is `system` and yielding to plugin requests (so a full-screen layer such as a wallpaper shows through). Changing the setting takes effect immediately: after a save the settings page posts on the same-origin broadcast channel, and every open shell page and session card re-reads on receipt.

## Directory picker

DSH's workspace chooser dialog is provided by the `directory-picker` seam. The shell page installs a bridge before injecting the DSH index, so the dialog is raised by the host (`hana.resources.pick` with `mode=directory`) and what the user sees is a system dialog on their own machine — it does not go through the sandbox.

That bridge exists because the upstream fallback cannot work here: with no bridge, the native client half calls the DSH host process's OS chooser, which spawns a child process inside the sandbox to run `IFileOpenDialog` — upstream states that path only suits "the operator sitting in front of the host screen", whereas the managed runtime in this form is a background subprocess. If picking a directory raises an error, confirm the bridge is installed (`__DSH_DIRECTORY_PICKER__`) and that the host granted resource picking.
