// Do not submit while an IME is choosing a character (Safari also reports 229).
export function sendsChatOnEnter(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}

type Message = { id: string; senderId?: string };

export class ChatUnread {
  private rooms = new Map<string, { seen: Set<string>; unread: number }>();

  update(room: string, messages: Message[], selfId: string, reading: boolean) {
    const previous = this.rooms.get(room);
    // The first snapshot is history. Thereafter IDs, not list length or names,
    // identify arrivals even when the server's 100-message window rolls over.
    const arrivals = previous
      ? messages.filter(
          (message) =>
            !previous.seen.has(message.id) && message.senderId !== selfId,
        ).length
      : 0;
    const unread = reading ? 0 : (previous?.unread ?? 0) + arrivals;
    this.rooms.set(room, {
      seen: new Set(messages.map((message) => message.id)),
      unread,
    });
    return unread;
  }
}
