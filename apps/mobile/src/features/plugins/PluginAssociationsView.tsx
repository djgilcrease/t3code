import type { PluginAction, PluginAssociations } from "@t3tools/contracts";
import { useState } from "react";
import { View, TextInput } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

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
  const [searching, setSearching] = useState(false);
  return (
    <View className="gap-2">
      {(expanded ? block.selected : block.selected.slice(0, 1)).map((item) => (
        <View key={item.id} className="gap-1">
          <Button
            label={item.label}
            disabled={busy || !item.open}
            onPress={() => item.open && void run(item.open)}
          />
          <Button
            label={`Remove ${item.label}`}
            disabled={busy}
            onPress={() => void run(item.select)}
          />
        </View>
      ))}
      {block.selected.length > 1 && (
        <Button
          label={expanded ? "Show less" : `Show ${block.selected.length - 1} more`}
          onPress={() => setExpanded(!expanded)}
        />
      )}
      <Button label={block.label} onPress={() => setSearching(!searching)} />
      {searching && (
        <View className="gap-2">
          <TextInput
            accessibilityLabel={`Search ${block.label}`}
            value={query}
            maxLength={200}
            onChangeText={setQuery}
            onSubmitEditing={() => search(query)}
          />
          <Button label="Search" disabled={busy} onPress={() => search(query)} />
          {block.options.map((item) => (
            <Button
              key={item.id}
              label={item.label}
              disabled={busy}
              onPress={() => void run(item.select)}
            />
          ))}
          {block.options.length === 0 && <Text>No results</Text>}
          {block.nextCursor && (
            <Button
              label="Next page"
              disabled={busy}
              onPress={() => search(query, block.nextCursor)}
            />
          )}
        </View>
      )}
    </View>
  );
}
