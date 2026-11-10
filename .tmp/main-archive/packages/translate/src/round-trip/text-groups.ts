export interface TextContribution<Channel extends string> {
  readonly channel: Channel;
  readonly field: string;
  readonly text: string;
}

export interface TextGroup<Part extends object> {
  text: string;
  readonly segments: Array<{ readonly part: Part; readonly field: string; readonly offset: number }>;
}

export interface TextPlacement {
  readonly text: string;
  readonly offset: number;
}

export type TextPlacementIndex = Map<object, Map<string, TextPlacement>>;

export const collectTextGroups = <Part extends object, Channel extends string>(
  parts: readonly Part[],
  project: (part: Part) => TextContribution<Channel> | undefined,
): Map<Channel, TextGroup<Part>> => {
  const channels = new Map<Channel, TextGroup<Part>>();
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

export const collectTextPlacementIndex = <Part extends object>(
  channels: ReadonlyMap<string, TextGroup<Part>>,
  views: TextPlacementIndex,
): void => {
  for (const channel of channels.values()) {
    for (const { part, field, offset } of channel.segments) {
      const fields = views.get(part) ?? new Map();
      fields.set(field, { text: channel.text, offset });
      views.set(part, fields);
    }
  }
};
