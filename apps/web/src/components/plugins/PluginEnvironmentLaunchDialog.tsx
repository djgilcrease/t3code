import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type PluginInput } from "@t3tools/contracts";
import { pluginEnvironmentLaunchResult } from "@t3tools/client-runtime/plugins";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { environmentCatalog } from "../../connection/catalog";
import { managedPluginEnvironmentsAtom } from "../../state/plugins";
import { Dialog, DialogHeader, DialogTitle, DialogPopup, DialogPanel } from "../ui/dialog";
import { PluginPanels } from "./PluginPanels";

export function PluginEnvironmentLaunchDialog(props: {
  environmentId: EnvironmentId;
  pluginId: string;
  viewId: string;
  context: PluginInput;
  onClose: () => void;
  onAccepted?: (input: PluginInput) => void;
}) {
  const resources = useAtomValue(managedPluginEnvironmentsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const navigate = useNavigate();
  const opened = useRef(false);
  const destination = resources.find(
    (resource) =>
      resource.owner.environmentId === props.environmentId &&
      resource.owner.pluginId === props.pluginId &&
      resource.launchRequestId === props.context.requestId &&
      resource.state === "running" &&
      resource.threadId,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Opens the controller-created thread only after its connection has been registered locally.
  useEffect(() => {
    if (
      opened.current ||
      !destination?.threadId ||
      !catalog.entries.has(EnvironmentId.make(destination.environmentId))
    )
      return;
    opened.current = true;
    props.onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: EnvironmentId.make(destination.environmentId),
        threadId: ThreadId.make(destination.threadId),
      },
    });
  }, [destination, catalog, navigate, props]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New environment</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <PluginPanels
            environmentId={props.environmentId}
            location="environment-launcher"
            pluginId={props.pluginId}
            viewId={props.viewId}
            context={props.context}
            onCommandResult={(value) => {
              if (pluginEnvironmentLaunchResult(value)?.requestId === props.context.requestId)
                props.onAccepted?.(props.context);
            }}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
