import { PluginAssociationsView } from "./PluginAssociationsView";
import { launchImageLibraryAsync } from "expo-image-picker";
import { clientNoticeRoutingConflicted } from "@t3tools/client-runtime/notificationRouting";
import { pluginCatalogsAtom } from "../../state/plugins";
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
  PluginInput,
  PluginViewDescriptor,
} from "@t3tools/contracts";
import {
  pluginFormDefaults,
  pluginFormInput,
  pluginLink,
  pluginSecretResult,
  pluginNoticeResult,
  pluginViewResult,
  type PluginForm,
} from "@t3tools/client-runtime/plugins";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Image, Linking, ScrollView, Switch, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button as MaterialButton } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function associationQuery(selection: PluginInput) {
  const search = selection.associationSearch;
  return search &&
    typeof search === "object" &&
    !Array.isArray(search) &&
    typeof search.query === "string"
    ? search.query
    : "";
}

type Entry = PluginCatalog["plugins"][number];

export function PluginPanels({
  environmentId,
  location,
  pluginId,
  viewId,
  context,
  onCommandResult,
}: {
  environmentId: EnvironmentId;
  onCommandResult?: (result: unknown) => void;
  context?: PluginInput;
  pluginId?: string;
  viewId?: string;
  location: PluginViewDescriptor["location"];
}) {
  const routingConflict = clientNoticeRoutingConflicted(useAtomValue(pluginCatalogsAtom));
  const query = serverEnvironment.pluginCatalog({ environmentId, input: {} });
  const result = useAtomValue(query);
  const catalog = Option.getOrNull(AsyncResult.value(result));
  if (!catalog) return result._tag === "Failure" ? <Text>Plugins could not be loaded.</Text> : null;
  const available = catalog.plugins.some(
    (plugin) =>
      plugin.status === "active" &&
      plugin.id === pluginId &&
      plugin.views.some((view) => view.id === viewId && view.location === location),
  );
  if ((location === "settings-page" || location === "environment-launcher") && !available)
    return (
      <Text>
        This extension page is unavailable. Enable or reinstall its plugin in Plugins settings.
      </Text>
    );
  return (
    <View className="gap-4">
      {location === "settings-page" && routingConflict && (
        <Text>
          Multiple extensions or environments claim client notices. Keep notice routing enabled in
          one place; builtin presentation remains in control.
        </Text>
      )}
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
          .filter(
            (view) =>
              plugin.status === "active" &&
              view.location === location &&
              (!pluginId || plugin.id === pluginId) &&
              (!viewId || view.id === viewId),
          )
          .map((view) => (
            <PluginPanel
              key={`${plugin.id}:${view.id}:${JSON.stringify(context ?? {})}`}
              environmentId={environmentId}
              plugin={plugin}
              view={view}
              {...(context ? { context } : {})}
              {...(onCommandResult ? { onCommandResult } : {})}
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
  context,
  onCommandResult,
}: {
  environmentId: EnvironmentId;
  plugin: Entry;
  view: PluginViewDescriptor;
  onCommandResult?: (result: unknown) => void;
  context?: PluginInput;
}) {
  const [selection, setSelection] = useState<PluginInput>({});
  const query = serverEnvironment.pluginView({
    environmentId,
    input: { pluginId: plugin.id, viewId: view.id, context: { ...context, ...selection } },
  });
  const result = useAtomValue(query);
  const [page, setPage] = useState<ReturnType<typeof pluginViewResult>>(null);
  const content = page?.view ?? Option.getOrNull(AsyncResult.value(result));
  const registry = useContext(RegistryContext);
  const execute = useAtomCommand(serverEnvironment.executePluginCommand);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const [secret, setSecret] = useState<ReturnType<typeof pluginSecretResult>>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<ReturnType<typeof pluginNoticeResult>>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Secret expiry owns a timer cancelled on replacement or unmount.
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
    setNotice(null);
    return execute({
      environmentId,
      input: {
        pluginId: plugin.id,
        commandId: command.id,
        permission: command.permission,
        input: action.input,
      },
    })
      .then((outcome) => {
        if (outcome._tag === "Success") {
          setSecret(pluginSecretResult(outcome.value));
          setNotice(pluginNoticeResult(outcome.value));
          const nextPage = pluginViewResult(outcome.value);
          if (nextPage) setPage(nextPage);
          onCommandResult?.(outcome.value);
        }
        if (outcome._tag === "Failure" && !isAtomCommandInterrupted(outcome)) {
          const failure = squashAtomCommandFailure(outcome);
          setError(
            failure instanceof Error ? failure.message : "The plugin command failed. Try again.",
          );
        }
        registry.refresh(query);
        return (
          outcome._tag === "Success" &&
          !["danger", "warning"].includes(pluginNoticeResult(outcome.value)?.tone ?? "success")
        );
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  };
  if (content?.blocks.length === 0 && !page) return null;
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-t3-medium text-foreground">{content?.title ?? view.title}</Text>
      <MaterialButton
        label={page ? "Back" : "Refresh"}
        onPress={() => {
          setPage(null);
          registry.refresh(query);
        }}
      />
      {notice && (
        <Text accessibilityRole={notice.tone === "danger" ? "alert" : "text"}>{notice.text}</Text>
      )}
      {error && <Text accessibilityRole="alert">{error}</Text>}
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
        if (block.kind === "toggle")
          return (
            <View key={block.id} className="flex-row items-center justify-between">
              <Text>{block.label}</Text>
              <Switch
                accessibilityLabel={block.label}
                value={block.value}
                disabled={
                  busy || !plugin.commands.some((command) => command.id === block.action.command)
                }
                onValueChange={() => void run(block.action)}
              />
            </View>
          );
        if (block.kind === "associations")
          return (
            <PluginAssociationsView
              key={block.id}
              block={block}
              busy={busy}
              run={run}
              submittedQuery={associationQuery(selection)}
              canRun={(action) => plugin.commands.some((command) => command.id === action.command)}
              search={(query, cursor) =>
                setSelection((current) => ({
                  ...current,
                  associationSearch: { blockId: block.id, query, ...(cursor ? { cursor } : {}) },
                }))
              }
            />
          );

        if (block.kind === "collection")
          return (
            <PluginCollection
              key={block.id}
              block={block}
              select={(input) => setSelection((current) => ({ ...current, ...input }))}
            />
          );
        if (block.kind === "image")
          return (
            <Image
              key={block.id}
              accessibilityLabel={block.label}
              source={{ uri: block.source }}
              style={{ width: "100%", height: 300 }}
              resizeMode="contain"
            />
          );
        if (block.kind === "code")
          return (
            <ScrollView key={block.id} horizontal>
              <Text selectable style={{ fontFamily: "monospace" }}>
                {block.text}
              </Text>
            </ScrollView>
          );
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
              key={block.instance ?? JSON.stringify(block)}
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
        if (block.kind === "status" || block.kind === "environment") return null;
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
  form: incoming,
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
  const [snapshot, setSnapshot] = useState<PluginForm | null>(null);
  const form = snapshot ?? incoming;
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
              onValueChange={(value) => {
                setSnapshot((current) => current ?? incoming);
                setValues({ ...values, [field.name]: value });
              }}
            />
          ) : field.kind === "select" ? (
            <View className="gap-1">
              {field.options?.map((option) => (
                <MaterialButton
                  key={option.value}
                  label={`${values[field.name] === option.value ? "✓ " : ""}${option.label}`}
                  disabled={busy || !allowed}
                  onPress={() => {
                    setSnapshot((current) => current ?? incoming);
                    setValues({ ...values, [field.name]: option.value });
                  }}
                />
              ))}
            </View>
          ) : field.kind === "image" ? (
            <MaterialButton
              label="Choose image (at most 64 KiB)"
              disabled={busy || !allowed}
              onPress={() => {
                void launchImageLibraryAsync({ mediaTypes: ["images"], base64: true })
                  .then((result) => {
                    const asset = result.assets?.[0];
                    if (!asset?.base64 || asset.base64.length > 87384) {
                      setInvalid(true);
                      return;
                    }
                    setValues({
                      ...values,
                      [field.name]: `data:${asset.mimeType ?? "image/jpeg"};base64,${asset.base64}`,
                    });
                  })
                  .catch(() => setInvalid(true));
              }}
            />
          ) : (
            <TextInput
              accessibilityLabel={field.label}
              value={String(values[field.name] ?? "")}
              editable={!busy && allowed}
              secureTextEntry={field.kind === "password"}
              multiline={field.kind === "multiline"}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={field.kind === "number" ? "numeric" : "default"}
              className="min-h-12 rounded-lg border border-border px-3 text-foreground"
              onChangeText={(value) => {
                setSnapshot((current) => current ?? incoming);
                setValues({ ...values, [field.name]: value });
              }}
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
                if (success) {
                  setValues(null);
                  setSnapshot(null);
                }
              },
            );
        }}
      />
    </View>
  );
}

function PluginCollection({
  block,
  select,
}: {
  block: Extract<import("@t3tools/contracts").PluginBlock, { kind: "collection" }>;
  select: (input: PluginInput) => void;
}) {
  const [search, setSearch] = useState("");
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel={`Search ${block.label}`}
        placeholder={`Search ${block.label}`}
        value={search}
        onChangeText={(value) => {
          setSearch(value);
          if (block.queryField) select({ [block.queryField]: value });
        }}
      />
      {block.items
        .filter(
          (item) =>
            block.queryField !== undefined ||
            `${item.label} ${item.search}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
        )
        .map((item) => (
          <MaterialButton key={item.id} label={item.label} onPress={() => select(item.input)} />
        ))}
    </View>
  );
}
