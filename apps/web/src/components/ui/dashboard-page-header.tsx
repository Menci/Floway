import { fluentComponents } from '../../fluent';

const { Text, mergeClasses } = fluentComponents;

export function DashboardPageHeader({ actions, className, description, title }: {
  actions?: React.ReactNode;
  className?: string;
  description?: string;
  title: string;
}) {
  // Centred against the whole block rather than aligned to its first line: the
  // actions answer the page, not its title.
  return <header className={mergeClasses('flex items-center gap-[18px] justify-between min-w-0 max-[900px]:flex-col max-[900px]:items-stretch', className)}>
    <div className="grid gap-1.5 min-w-0">
      <Text as="h1" size={700} weight="semibold" className="m-0">
        {title}
      </Text>
      {description !== undefined && <Text size={200} className="text-fui-fg2 max-w-[760px]">
        {description}
      </Text>}
    </div>
    {actions !== undefined && <div className="flex items-center gap-2 flex-none max-[900px]:justify-start">
      {actions}
    </div>}
  </header>;
}
