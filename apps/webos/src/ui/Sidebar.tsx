/**
 * Group sidebar.
 *
 * Short enough that virtualization would be overhead rather than a saving —
 * this provider has 6 groups, and even large playlists rarely exceed a few
 * dozen. The scroll container handles the rest.
 */

import { For, Show } from "solid-js";

export interface GroupEntry {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  /** Favourites and "All" are pinned above the provider's own groups. */
  readonly pinned?: boolean;
}

interface Props {
  readonly groups: readonly GroupEntry[];
  readonly selectedId: string;
  readonly focused: boolean;
  readonly onSelect: (id: string) => void;
}

export function Sidebar(props: Props) {
  return (
    <nav class="sidebar" classList={{ focused: props.focused }}>
      <For each={props.groups}>
        {(group) => (
          <div
            class="sidebar-item"
            classList={{
              selected: group.id === props.selectedId,
              inactive: group.id === props.selectedId && !props.focused,
              pinned: group.pinned === true,
            }}
            onClick={() => props.onSelect(group.id)}
          >
            <Show when={group.id === "favourites"}>
              <span class="sidebar-icon">★</span>
            </Show>
            <span class="sidebar-label">{group.label}</span>
            <span class="sidebar-count">{group.count}</span>
          </div>
        )}
      </For>
    </nav>
  );
}
