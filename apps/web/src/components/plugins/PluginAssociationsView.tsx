import type { PluginAction, PluginAssociations } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PluginAssociationsView({
  block,
  busy,
  run,
  search,
}: {
  block: PluginAssociations;
  busy: boolean;
  run: (action: PluginAction) => Promise<boolean>;
  search: (query: string, cursor?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const selected = expanded ? block.selected : block.selected.slice(0, 1);
  return (
    <div className="space-y-2">
      {selected.map((item) => (
        <div key={item.id} className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !item.open}
            onClick={() => item.open && void run(item.open)}
          >
            {item.label}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run(item.select)}
            aria-label={`Remove ${item.label}`}
          >
            Remove
          </Button>
        </div>
      ))}
      {block.selected.length > 1 && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : `Show ${block.selected.length - 1} more`}
        </Button>
      )}
      <details>
        <summary>{block.label}</summary>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            search(query);
          }}
        >
          <Input
            aria-label={`Search ${block.label}`}
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button variant="outline" size="sm" type="submit" disabled={busy}>
            Search
          </Button>
        </form>
        <div role="group" aria-label={block.label} className="flex max-h-64 flex-col overflow-auto">
          {block.options.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(item.select)}
              aria-pressed={block.selected.some((selected) => selected.id === item.id)}
            >
              {item.label}
            </Button>
          ))}
          {block.options.length === 0 && (
            <p role="status" className="px-2 py-1 text-sm text-muted-foreground">
              No matching items.
            </p>
          )}
        </div>
        {block.nextCursor && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => search(query, block.nextCursor)}
          >
            Next page
          </Button>
        )}
      </details>
    </div>
  );
}
