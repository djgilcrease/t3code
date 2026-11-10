import { createPluginSummaryAtoms } from "@t3tools/client-runtime/state/plugins";

import { connectedEnvironmentIdsAtom } from "./presentation";
import { serverEnvironment } from "./server";

export const { pluginCatalogsAtom, pluginStatusByEnvironmentAtom } = createPluginSummaryAtoms({
  connectedEnvironmentIdsAtom,
  pluginCatalog: serverEnvironment.pluginCatalog,
  pluginView: serverEnvironment.pluginView,
});
