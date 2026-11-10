import { useAtomValue } from "@effect/atom-react";
import { pluginSettingsPages } from "@t3tools/client-runtime/plugins";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { openSettings } from "../settings/settings-navigation";
import { useNavigation } from "@react-navigation/native";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsRow } from "../settings/components/SettingsRow";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";

const pagesAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as readonly { environmentId: EnvironmentId; label: string }[];
    return targets.flatMap((target) => {
      const result = get(
        serverEnvironment.pluginCatalog({ environmentId: target.environmentId, input: {} }),
      );
      const catalog = AsyncResult.getOrElse(result, () => null);
      return catalog ? pluginSettingsPages(catalog).map((page) => ({ ...target, ...page })) : [];
    });
  }),
);
export function usePluginSettingsPages() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const pages = useAtomValue(
    pagesAtom(
      JSON.stringify(selectedTargets.map(({ environmentId, label }) => ({ environmentId, label }))),
    ),
  );
  return selectedProjectKey === null ? pages : [];
}

export function PluginSettingsLinks({ query }: { query: string }) {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const navigation = useNavigation();
  const pages = usePluginSettingsPages();
  const visible = pages.filter((page) =>
    page.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  if (visible.length === 0) return null;
  return (
    <SettingsSection title="Extensions">
      {visible.map((page) => (
        <SettingsRow
          key={`${page.environmentId}:${page.pluginId}:${page.viewId}`}
          icon="server.rack"
          label={page.title}
          value={selectedTargets.length > 1 ? page.label : undefined}
          onPress={() =>
            openSettings(navigation, "SettingsPluginPage", {
              environmentId: page.environmentId,
              pluginId: page.pluginId,
              viewId: page.viewId,
            })
          }
        />
      ))}
    </SettingsSection>
  );
}
