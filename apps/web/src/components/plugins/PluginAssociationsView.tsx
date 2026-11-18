import { T, useGT } from "gt-react";
import type { PluginAction, PluginAssociations } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PluginAssociationsView({
  block,
  busy,
  run,
  search,
  canRun,
  submittedQuery,
}: {
  block: PluginAssociations;
  busy: boolean;
  run: (action: PluginAction) => Promise<boolean>;
  search: (query: string, cursor?: string) => void;
  canRun: (action: PluginAction) => boolean;
  submittedQuery: string;
}) {
  const gt = useGT();
  const [query, setQuery] = useState(submittedQuery);
  const submitted = submittedQuery;
  const submit = () => {
    search(query);
  };
  const [expanded, setExpanded] = useState(false);
  const selected = expanded ? block.selected : block.selected.slice(0, 1);
  return (
    <div className="space-y-2">
      {selected.map((item) => (
        <div key={item.id} className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm hover:bg-accent disabled:opacity-50"
            aria-label={item.label}
            disabled={busy || !item.open || !canRun(item.open)}
            onClick={() => item.open && void run(item.open)}
          >
            {item.label}
          </button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !canRun(item.select)}
            onClick={() => void run(item.select)}
            aria-label={gt("Remove {value0}", { value0: item.label })}
          >
            <T>Remove</T>
          </Button>
        </div>
      ))}
      {block.clear && block.selected.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !canRun(block.clear)}
          onClick={() => block.clear && void run(block.clear)}
        >
          {block.clear.label}
        </Button>
      )}
      {block.selected.length > 1 && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
          {expanded
            ? gt("Show less")
            : gt("Show {value0} more", { value0: block.selected.length - 1 })}
        </Button>
      )}
      <details>
        <summary>{block.label}</summary>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            aria-label={gt("Search {value0}", { value0: block.label })}
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button variant="outline" size="sm" type="submit" disabled={busy}>
            <T>Search</T>
          </Button>
        </form>
        <div role="group" aria-label={block.label} className="flex max-h-64 flex-col overflow-auto">
          {block.options.map((item) => (
            <button
              key={item.id}
              type="button"
              className="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent disabled:opacity-50"
              aria-label={item.label}
              disabled={busy || !canRun(item.select)}
              onClick={() => void run(item.select)}
              aria-pressed={block.selected.some((selected) => selected.id === item.id)}
            >
              {item.label}
            </button>
          ))}
          {block.options.length === 0 && (
            <p role="status" className="px-2 py-1 text-sm text-muted-foreground">
              <T>No matching items.</T>
            </p>
          )}
        </div>
        {block.nextCursor && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || query !== submitted}
            onClick={() => search(submitted, block.nextCursor)}
          >
            <T>Next page</T>
          </Button>
        )}
      </details>
    </div>
  );
}
