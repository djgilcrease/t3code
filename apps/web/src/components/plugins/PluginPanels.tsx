import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PluginManagement } from "./PluginManagement";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PluginAction,
  PluginCatalog,
  PluginCommandDescriptor,
  PluginCommandInput,
  PluginInput,
  PluginViewDescriptor,
} from "@t3tools/contracts";
import {
  pluginFormDefaults,
  pluginFormInput,
  pluginLink,
  pluginSecretResult,
  type PluginForm,
} from "@t3tools/client-runtime/plugins";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useContext, useEffect, useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type Entry = PluginCatalog["plugins"][number];
type Location = PluginViewDescriptor["location"];

/** Mounted only on feature surfaces; plugins add no transcript render work. */
export function PluginPanels({
  environmentId,
  location,
}: {
  environmentId: EnvironmentId;
  location: Location;
}) {
  const query = serverEnvironment.pluginCatalog({ environmentId, input: {} });
  const result = useAtomValue(query);
  const catalog = Option.getOrNull(AsyncResult.value(result));
  if (!catalog)
    return result._tag === "Failure" ? <p role="status">Plugins could not be loaded.</p> : null;
  return (
    <div className="space-y-4">
      {catalog.configurationError && (
        <p role="status">
          Plugin configuration could not be loaded. Check plugins.json on this environment.
        </p>
      )}
      {location === "settings" && (
        <PluginManagement environmentId={environmentId} catalog={catalog} />
      )}
      {catalog.plugins.flatMap((plugin) =>
        plugin.views
          .filter((v) => v.location === location)
          .map((view) => (
            <PluginPanel
              key={`${plugin.id}:${view.id}`}
              environmentId={environmentId}
              plugin={plugin}
              view={view}
            />
          )),
      )}
    </div>
  );
}

function PluginPanel({
  environmentId,
  plugin,
  view,
}: {
  environmentId: EnvironmentId;
  plugin: Entry;
  view: PluginViewDescriptor;
}) {
  const query = serverEnvironment.pluginView({
    environmentId,
    input: { pluginId: plugin.id, viewId: view.id },
  });
  const result = useAtomValue(query);
  const content = Option.getOrNull(AsyncResult.value(result));
  const registry = useContext(RegistryContext);
  const execute = useAtomCommand(serverEnvironment.executePluginCommand);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const [secret, setSecret] = useState<ReturnType<typeof pluginSecretResult>>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!secret) return;
    const timer = setTimeout(() => setSecret(null), 30_000);
    return () => clearTimeout(timer);
  }, [secret]);
  const run = async (action: PluginAction) => {
    const command = plugin.commands.find((command) => command.id === action.command);
    if (!command || running.current) return false;
    running.current = true;
    setSecret(null);
    setCopied(false);
    setBusy(true);
    setError(null);
    try {
      const outcome = await execute({
        environmentId,
        input: {
          pluginId: plugin.id,
          commandId: command.id,
          permission: command.permission,
          input: action.input,
        },
      });
      if (outcome._tag === "Success") setSecret(pluginSecretResult(outcome.value));
      if (outcome._tag === "Failure" && !isAtomCommandInterrupted(outcome)) {
        const failure = squashAtomCommandFailure(outcome);
        setError(
          failure instanceof Error ? failure.message : "The plugin command failed. Try again.",
        );
      }
      registry.refresh(query);
      return outcome._tag === "Success";
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={view.title}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{content?.title ?? view.title}</h3>
        <Button size="sm" variant="ghost" onClick={() => registry.refresh(query)}>
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {secret && (
        <div className="space-y-2 rounded-md border p-3" role="region" aria-label={secret.label}>
          <label className="block space-y-1 text-sm">
            <span>{secret.label}</span>
            <Input type="password" readOnly value={secret.value} autoComplete="off" />
          </label>
          <p className="text-xs text-muted-foreground">
            Hidden again after 30 seconds. Copy only to a destination you trust.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(secret.value)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }
            >
              {copied ? "Copied" : "Copy key"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>
              Dismiss key
            </Button>
          </div>
        </div>
      )}
      {result._tag === "Failure" && <p role="alert">This plugin view could not be loaded.</p>}
      {content?.blocks.map((block) => {
        if (block.kind === "text")
          return (
            <p key={block.id} className="whitespace-pre-wrap text-sm">
              {block.text}
            </p>
          );
        if (block.kind === "link") {
          const href = pluginLink(block.url);
          return href ? (
            <a
              key={block.id}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-sm underline"
            >
              {block.label}
            </a>
          ) : null;
        }
        if (block.kind === "actions")
          return (
            <div key={block.id} className="flex flex-wrap gap-2">
              {block.actions.map((action) => (
                <PluginActionButton
                  key={action.id}
                  action={action}
                  environmentId={environmentId}
                  plugin={plugin}
                  busy={busy}
                  run={run}
                />
              ))}
            </div>
          );
        if (block.kind === "form")
          return (
            <PluginFormView
              key={block.id}
              form={block}
              environmentId={environmentId}
              plugin={plugin}
              busy={busy}
              run={run}
            />
          );
        return (
          <div key={block.id} className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {block.columns.map((column) => (
                    <th key={column} className="p-2">
                      {column}
                    </th>
                  ))}
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row.id}>
                    {row.cells.map((cell, k) => (
                      <td key={block.columns[k]} className="p-2">
                        {cell}
                      </td>
                    ))}
                    <td>
                      <div className="flex gap-2">
                        {row.actions.map((action) => (
                          <PluginActionButton
                            key={action.id}
                            action={action}
                            environmentId={environmentId}
                            plugin={plugin}
                            busy={busy}
                            run={run}
                          />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}

function commandInput(
  plugin: Entry,
  command: PluginCommandDescriptor | undefined,
  action: PluginAction,
): PluginCommandInput {
  return {
    pluginId: plugin.id,
    commandId: action.command,
    permission: command?.permission ?? "environment:maintain",
    input: action.input,
  };
}
function PluginActionButton({
  action,
  environmentId,
  plugin,
  busy,
  run,
}: {
  action: PluginAction;
  environmentId: EnvironmentId;
  plugin: Entry;
  busy: boolean;
  run: (action: PluginAction) => Promise<boolean>;
}) {
  const command = plugin.commands.find((command) => command.id === action.command);
  const allowed = useAtomValue(
    serverEnvironment.executePluginCommand.permissionAtom(
      environmentId,
      commandInput(plugin, command, action),
    ),
  );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!command || !allowed || busy}
      onClick={() => void run(action)}
    >
      {action.label}
    </Button>
  );
}
function PluginFormView({
  form,
  environmentId,
  plugin,
  busy,
  run,
}: {
  form: PluginForm;
  environmentId: EnvironmentId;
  plugin: Entry;
  busy: boolean;
  run: (action: PluginAction) => Promise<boolean>;
}) {
  const [draft, setValues] = useState<PluginInput | null>(null);
  const values = { ...pluginFormDefaults(form), ...draft };
  const [invalid, setInvalid] = useState(false);
  const command = plugin.commands.find((command) => command.id === form.command);
  const action = { id: form.id, label: form.label, command: form.command, input: form.input };
  const allowed = useAtomValue(
    serverEnvironment.executePluginCommand.permissionAtom(
      environmentId,
      commandInput(plugin, command, action),
    ),
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const input = pluginFormInput(form, values);
        setInvalid(input === null);
        if (input !== null)
          void run({ ...action, input }).then((success) => {
            if (success) setValues(null);
          });
      }}
    >
      {form.fields.map((field) => (
        <label key={field.name} className="block space-y-1 text-sm">
          <span>{field.label}</span>
          {field.kind === "boolean" ? (
            <input
              type="checkbox"
              checked={values[field.name] === true}
              disabled={busy || !allowed}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.checked })}
            />
          ) : field.kind === "select" ? (
            <select
              className="w-full rounded-md border bg-background p-2"
              value={String(values[field.name] ?? "")}
              disabled={busy || !allowed}
              required={field.required}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
            >
              <option value="">Select…</option>
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              type={field.kind}
              step={field.kind === "number" ? "any" : undefined}
              value={String(values[field.name] ?? "")}
              autoComplete={field.kind === "password" ? "off" : undefined}
              required={field.required}
              disabled={busy || !allowed}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
            />
          )}
        </label>
      ))}
      {invalid && <p role="alert">Complete the required fields with valid values.</p>}
      <Button size="sm" type="submit" disabled={!command || !allowed || busy}>
        {form.label}
      </Button>
    </form>
  );
}
