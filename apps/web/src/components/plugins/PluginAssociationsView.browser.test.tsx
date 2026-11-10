import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { PluginAssociationsView } from "./PluginAssociationsView";

it("retains the submitted query when search results remount and paginate", async () => {
  const search = vi.fn();
  await using screen = await render(
    <PluginAssociationsView
      block={{
        id: "issues",
        kind: "associations",
        label: "Issues",
        selected: [],
        options: [],
        nextCursor: "next",
      }}
      submittedQuery="source-control"
      busy={false}
      run={async () => true}
      canRun={() => true}
      search={search}
    />,
  );
  await screen.getByText("Issues", { exact: true }).click();
  await expect.element(screen.getByRole("textbox")).toHaveValue("source-control");
  await screen.getByRole("button", { name: "Next page" }).click();
  expect(search).toHaveBeenCalledWith("source-control", "next");
  await screen.getByRole("textbox").fill("another search");
  await expect.element(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
});
