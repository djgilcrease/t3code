import { createFileRoute } from "@tanstack/react-router";
import { ModelProxySettings } from "../components/settings/ModelProxySettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsModelProxyRoute() {
  const { environment } = useSettingsScope();
  return environment ? (
    <ModelProxySettings key={environment.environmentId} environmentId={environment.environmentId} />
  ) : (
    <p className="p-8 text-sm text-muted-foreground">
      Connect an environment to configure T3 Proxy.
    </p>
  );
}

export const Route = createFileRoute("/settings/model-proxy")({
  component: SettingsModelProxyRoute,
});
