import { createPluginSummaryAtoms } from "@t3tools/client-runtime/state/plugins";

import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

export const { pluginCatalogsAtom, pluginStatusByEnvironmentAtom, managedPluginEnvironmentsAtom } =
  createPluginSummaryAtoms({
    connectedEnvironmentIdsAtom: environmentSummaries.connectedEnvironmentIdsAtom,
    pluginCatalog: serverEnvironment.pluginCatalog,
    pluginView: serverEnvironment.pluginView,
  });
