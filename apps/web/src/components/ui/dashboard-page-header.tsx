import { fluentComponents } from '../../fluent';

const { Text } = fluentComponents;

export function DashboardPageHeader({ actions, description, eyebrow, title }: {
  actions?: React.ReactNode;
  description?: string;
  eyebrow: string;
  title: string;
}) {
  return <header className="flex items-start gap-[18px] justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch">
    <div className="grid gap-[6px] min-w-0">
      <Text size={200} weight="semibold" className="text-fui-fg2 uppercase">
        {eyebrow}
      </Text>
      <Text as="h1" size={700} weight="semibold" className="m-0">
        {title}
      </Text>
      {description !== undefined && <Text size={300} className="text-fui-fg2 max-w-[760px]">
        {description}
      </Text>}
    </div>
    {actions !== undefined && <div className="flex items-center gap-2 flex-none max-[900px]:justify-start">
      {actions}
    </div>}
  </header>;
}
