export interface TextChannelProjection<Channel extends string> {
  readonly channel: Channel;
  readonly field: string;
  readonly text: string;
}

export interface TextChannel<Part extends object> {
  text: string;
  readonly segments: Array<{ readonly part: Part; readonly field: string; readonly offset: number }>;
}

export interface TextChannelView {
  readonly text: string;
  readonly offset: number;
}

export type TextChannelViews = Map<object, Map<string, TextChannelView>>;

export const collectTextChannels = <Part extends object, Channel extends string>(
  parts: readonly Part[],
  project: (part: Part) => TextChannelProjection<Channel> | undefined,
): Map<Channel, TextChannel<Part>> => {
  const channels = new Map<Channel, TextChannel<Part>>();
  for (const part of parts) {
    const projected = project(part);
    if (projected === undefined) continue;
    const channel = channels.get(projected.channel) ?? { text: '', segments: [] };
    channel.segments.push({ part, field: projected.field, offset: channel.text.length });
    channel.text += projected.text;
    channels.set(projected.channel, channel);
  }
  return channels;
};

export const collectTextChannelViews = <Part extends object>(
  channels: ReadonlyMap<string, TextChannel<Part>>,
  views: TextChannelViews,
): void => {
  for (const channel of channels.values()) {
    for (const { part, field, offset } of channel.segments) {
      const fields = views.get(part) ?? new Map();
      fields.set(field, { text: channel.text, offset });
      views.set(part, fields);
    }
  }
};
