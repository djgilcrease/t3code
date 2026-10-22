import { PluginManagement } from "./PluginManagement";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PluginAction,
  PluginCatalog,
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
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Linking, Switch, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button as MaterialButton } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

type Entry = PluginCatalog["plugins"][number];

export function PluginPanels({
  environmentId,
  location,
}: {
  environmentId: EnvironmentId;
  location: PluginViewDescriptor["location"];
}) {
  const query = serverEnvironment.pluginCatalog({ environmentId, input: {} });
  const result = useAtomValue(query);
  const catalog = Option.getOrNull(AsyncResult.value(result));
  if (!catalog) return result._tag === "Failure" ? <Text>Plugins could not be loaded.</Text> : null;
  return (
    <View className="gap-4">
      {catalog.configurationError && (
        <Text>
          Plugin configuration could not be loaded. Check plugins.json on this environment.
        </Text>
      )}
      {location === "settings" && (
        <PluginManagement environmentId={environmentId} catalog={catalog} />
      )}
      {catalog.plugins.flatMap((plugin) =>
        plugin.views
          .filter((view) => view.location === location)
          .map((view) => (
            <PluginPanel
              key={`${plugin.id}:${view.id}`}
              environmentId={environmentId}
              plugin={plugin}
              view={view}
            />
          )),
      )}
    </View>
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
      registry.refresh(query);
      return outcome._tag === "Success";
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-t3-medium text-foreground">{content?.title ?? view.title}</Text>
      <MaterialButton label="Refresh" onPress={() => registry.refresh(query)} />
      {secret && (
        <View className="gap-2 rounded-lg border border-border p-3">
          <Text>{secret.label}</Text>
          <TextInput
            accessibilityLabel={secret.label}
            secureTextEntry
            editable={false}
            value={secret.value}
            className="min-h-12 rounded-lg border border-border px-3 text-foreground"
          />
          <Text>Hidden again after 30 seconds. Copy only to a destination you trust.</Text>
          <MaterialButton
            label={copied ? "Copied" : "Copy key"}
            onPress={() =>
              void Clipboard.setStringAsync(secret.value)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          />
          <MaterialButton label="Dismiss key" onPress={() => setSecret(null)} />
        </View>
      )}
      {result._tag === "Failure" && (
        <Text accessibilityRole="alert">This plugin view could not be loaded.</Text>
      )}
      {content?.blocks.map((block) => {
        if (block.kind === "text")
          return (
            <Text key={block.id} selectable>
              {block.text}
            </Text>
          );
        if (block.kind === "link") {
          const url = pluginLink(block.url);
          return url ? (
            <MaterialButton
              key={block.id}
              label={block.label}
              onPress={() => void Linking.openURL(url)}
            />
          ) : null;
        }
        if (block.kind === "form")
          return (
            <PluginFormView
              key={block.id}
              form={block}
              plugin={plugin}
              environmentId={environmentId}
              busy={busy}
              run={run}
            />
          );
        if (block.kind === "actions")
          return (
            <View key={block.id} className="flex-row flex-wrap gap-2">
              {block.actions.map((action) => (
                <Action
                  key={action.id}
                  action={action}
                  plugin={plugin}
                  environmentId={environmentId}
                  busy={busy}
                  run={run}
                />
              ))}
            </View>
          );
        return (
          <View key={block.id} className="gap-3">
            {block.rows.map((row) => (
              <View key={row.id} className="gap-2 border-b border-border pb-3">
                {row.cells.map((cell, k) => (
                  <Text key={block.columns[k]} selectable>
                    {block.columns[k]}: {cell}
                  </Text>
                ))}
                <View className="flex-row flex-wrap gap-2">
                  {row.actions.map((action) => (
                    <Action
                      key={action.id}
                      action={action}
                      plugin={plugin}
                      environmentId={environmentId}
                      busy={busy}
                      run={run}
                    />
                  ))}
                </View>
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

function useCommandAllowed(environmentId: EnvironmentId, plugin: Entry, commandId: string) {
  const command = plugin.commands.find((command) => command.id === commandId);
  const allowed = useAtomValue(
    serverEnvironment.executePluginCommand.permissionAtom(environmentId, {
      pluginId: plugin.id,
      commandId,
      input: {},
      permission: command?.permission ?? "environment:maintain",
    }),
  );
  return command !== undefined && allowed;
}
function Action({
  action,
  plugin,
  environmentId,
  busy,
  run,
}: {
  action: PluginAction;
  plugin: Entry;
  environmentId: EnvironmentId;
  busy: boolean;
  run: (action: PluginAction) => Promise<boolean>;
}) {
  const allowed = useCommandAllowed(environmentId, plugin, action.command);
  return (
    <MaterialButton
      label={action.label}
      disabled={busy || !allowed}
      onPress={() => void run(action)}
    />
  );
}
function PluginFormView({
  form,
  plugin,
  environmentId,
  busy,
  run,
}: {
  form: PluginForm;
  plugin: Entry;
  environmentId: EnvironmentId;
  busy: boolean;
  run: (action: PluginAction) => Promise<boolean>;
}) {
  const [draft, setValues] = useState<PluginInput | null>(null);
  const values = { ...pluginFormDefaults(form), ...draft };
  const [invalid, setInvalid] = useState(false);
  const allowed = useCommandAllowed(environmentId, plugin, form.command);
  return (
    <View className="gap-3">
      {form.fields.map((field) => (
        <View key={field.name} className="gap-2">
          <Text>{field.label}</Text>
          {field.kind === "boolean" ? (
            <Switch
              accessibilityLabel={field.label}
              value={values[field.name] === true}
              disabled={busy || !allowed}
              onValueChange={(value) => setValues({ ...values, [field.name]: value })}
            />
          ) : field.kind === "select" ? (
            <View className="gap-1">
              {field.options?.map((option) => (
                <MaterialButton
                  key={option.value}
                  label={`${values[field.name] === option.value ? "✓ " : ""}${option.label}`}
                  disabled={busy || !allowed}
                  onPress={() => setValues({ ...values, [field.name]: option.value })}
                />
              ))}
            </View>
          ) : (
            <TextInput
              accessibilityLabel={field.label}
              value={String(values[field.name] ?? "")}
              editable={!busy && allowed}
              secureTextEntry={field.kind === "password"}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={field.kind === "number" ? "numeric" : "default"}
              className="min-h-12 rounded-lg border border-border px-3 text-foreground"
              onChangeText={(value) => setValues({ ...values, [field.name]: value })}
            />
          )}
        </View>
      ))}
      {invalid && (
        <Text accessibilityRole="alert">Complete the required fields with valid values.</Text>
      )}
      <MaterialButton
        label={form.label}
        disabled={busy || !allowed}
        onPress={() => {
          const input = pluginFormInput(form, values);
          setInvalid(input === null);
          if (input !== null)
            void run({ id: form.id, label: form.label, command: form.command, input }).then(
              (success) => {
                if (success) setValues(null);
              },
            );
        }}
      />
    </View>
  );
}
