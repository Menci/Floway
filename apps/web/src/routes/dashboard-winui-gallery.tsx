import {
  AddRegular,
  ArrowClockwiseRegular,
  DeleteRegular,
  DismissRegular,
  DocumentRegular,
  KeyRegular,
  MoreHorizontalRegular,
  SaveRegular,
  ServerRegular,
} from '@fluentui/react-icons';
import { useRef, useState } from 'react';

import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Combobox, Dropdown } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { StatusBadge } from '../components/ui/status-badge';
import { fluentComponents } from '../fluent';

const {
  Accordion,
  AlphaSlider,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ColorArea,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  CounterBadge,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Divider,
  EmptySwatch,
  Field,
  InlineDrawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Input,
  InteractionTag,
  InteractionTagPrimary,
  InteractionTagSecondary,
  Link,
  List,
  ListItem,
  Menu,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
  MenuItem,
  MenuItemCheckbox,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
} = fluentComponents;

const {
  NavCategory,
  NavCategoryItem,
  NavDrawer,
  NavDrawerBody,
  NavItem,
  NavSectionHeader,
  NavSubItem,
  NavSubItemGroup,
  Option,
  OverlayDrawer,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  ProgressBar,
  Radio,
  RadioGroup,
  Spinner,
  Switch,
  SwatchPicker,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableSelectionCell,
  Tag,
  Text,
  Textarea,
  Toast,
  ToastBody,
  ToastFooter,
  ToastTitle,
  Toaster,
  ToggleButton,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  ToolbarGroup,
  ToolbarToggleButton,
  Tooltip,
  useId: useFluentId,
  useToastController,
} = fluentComponents;

function Section({ children, id, title }: { children: React.ReactNode; id: string; title: string }) {
  return <section className="grid gap-4" id={id}>
    <SectionHeader level={2} title={title} />
    <Panel className={PANEL_STACK_CLASS}>{children}</Panel>
  </section>;
}

function Row({ children, label }: { children: React.ReactNode; label: string }) {
  return <div className="grid gap-2">
    <Text size={200} weight="semibold" className="text-fui-fg2 uppercase tracking-wide">{label}</Text>
    <div className="flex flex-wrap items-center gap-3">{children}</div>
  </div>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <Text italic size={200} className="text-fui-fg2">{children}</Text>;
}

function StateLabel({ children, state }: { children: React.ReactNode; state: string }) {
  return <div className="grid justify-items-start gap-1">
    <div>{children}</div>
    <Text size={100} className="text-fui-fg2">{state}</Text>
  </div>;
}

const buttonAppearances = ['secondary', 'primary', 'outline', 'subtle', 'transparent'] as const;

function ButtonSection() {
  return <Section id="button" title="Button">
    <Hint>Hover, press and tab through each row to reach the hover, pressed and focus-visible states.</Hint>
    {buttonAppearances.map(appearance => <Row key={appearance} label={appearance}>
      <StateLabel state="rest">
        <Button appearance={appearance}>Save upstream</Button>
      </StateLabel>
      <StateLabel state="with icon">
        <Button appearance={appearance} icon={<SaveRegular />}>Save upstream</Button>
      </StateLabel>
      <StateLabel state="icon only">
        <Button appearance={appearance} aria-label="Refresh models" icon={<ArrowClockwiseRegular />} />
      </StateLabel>
      <StateLabel state="disabled">
        <Button appearance={appearance} disabled>Save upstream</Button>
      </StateLabel>
      <StateLabel state="disabled, focusable">
        <Button appearance={appearance} disabledFocusable>Save upstream</Button>
      </StateLabel>
    </Row>)}
    <Row label="toggle button - checked and unchecked">
      <StateLabel state="unchecked"><ToggleButton checked={false}>Streaming</ToggleButton></StateLabel>
      <StateLabel state="checked"><ToggleButton checked>Streaming</ToggleButton></StateLabel>
      <StateLabel state="checked, primary"><ToggleButton appearance="primary" checked>Streaming</ToggleButton></StateLabel>
      <StateLabel state="checked, subtle"><ToggleButton appearance="subtle" checked>Streaming</ToggleButton></StateLabel>
      <StateLabel state="checked, disabled"><ToggleButton checked disabled>Streaming</ToggleButton></StateLabel>
    </Row>
    <Row label="sizes">
      <StateLabel state="small"><Button size="small">Retry</Button></StateLabel>
      <StateLabel state="medium"><Button size="medium">Retry</Button></StateLabel>
      <StateLabel state="large"><Button size="large">Retry</Button></StateLabel>
    </Row>
  </Section>;
}

function TextInputSection() {
  return <Section id="text-input" title="Text input">
    <Hint>Hover, click into and tab through each field to reach hover, focus-visible and the focused underline.</Hint>
    <Row label="input - appearances">
      <StateLabel state="outline (rest)"><Input defaultValue="https://api.githubcopilot.com" /></StateLabel>
      <StateLabel state="filled-darker"><Input appearance="filled-darker" defaultValue="gpt-5-codex" /></StateLabel>
      <StateLabel state="filled-lighter"><Input appearance="filled-lighter" defaultValue="gpt-5-codex" /></StateLabel>
    </Row>
    <Row label="input - states">
      <StateLabel state="placeholder"><Input placeholder="Upstream display name" /></StateLabel>
      <StateLabel state="disabled"><Input defaultValue="gpt-5-codex" disabled /></StateLabel>
      <StateLabel state="read-only"><Input defaultValue="gpt-5-codex" readOnly /></StateLabel>
      <StateLabel state="invalid">
        <Field validationMessage="Enter an absolute https:// URL." validationState="error">
          <Input defaultValue="api.githubcopilot" />
        </Field>
      </StateLabel>
      <StateLabel state="with contentBefore"><Input contentBefore={<KeyRegular />} defaultValue="sk-floway-…" /></StateLabel>
    </Row>
    <Row label="input - sizes">
      <StateLabel state="small"><Input defaultValue="1024" size="small" /></StateLabel>
      <StateLabel state="medium"><Input defaultValue="1024" size="medium" /></StateLabel>
      <StateLabel state="large"><Input defaultValue="1024" size="large" /></StateLabel>
    </Row>
    <Row label="textarea">
      <StateLabel state="rest"><Textarea defaultValue="You are a helpful assistant for the Floway gateway." /></StateLabel>
      <StateLabel state="filled-darker"><Textarea appearance="filled-darker" defaultValue="You are a helpful assistant." /></StateLabel>
      <StateLabel state="disabled"><Textarea defaultValue="You are a helpful assistant." disabled /></StateLabel>
      <StateLabel state="invalid">
        <Field validationMessage="System prompt cannot be empty." validationState="error">
          <Textarea defaultValue="" />
        </Field>
      </StateLabel>
    </Row>
  </Section>;
}

function ChoiceSection() {
  return <Section id="choice" title="Checkbox and radio">
    <Hint>Hover, press and tab through the controls to reach hover, pressed and focus-visible.</Hint>
    <Row label="checkbox - circular and square">
      <Checkbox defaultChecked={false} label="Unchecked" />
      <Checkbox defaultChecked label="Checked" />
      <Checkbox checked="mixed" label="Mixed" />
      <Checkbox disabled label="Disabled, unchecked" />
      <Checkbox checked disabled label="Disabled, checked" />
      <Checkbox checked="mixed" disabled label="Disabled, mixed" />
    </Row>
    <Row label="checkbox - label position">
      <Checkbox defaultChecked label="Label before" labelPosition="before" />
    </Row>
    <Row label="checkbox - invalid">
      <Field validationMessage="Accept the key rotation policy to continue." validationState="error">
        <Checkbox label="Rotate this API key every 90 days" />
      </Field>
    </Row>
    <Row label="radio group - vertical">
      <RadioGroup defaultValue="copilot">
        <Radio label="GitHub Copilot" value="copilot" />
        <Radio label="Azure AI Foundry" value="azure" />
        <Radio disabled label="Ollama (disabled)" value="ollama" />
      </RadioGroup>
    </Row>
    <Row label="radio group - horizontal, and disabled while checked">
      <RadioGroup defaultValue="stream" layout="horizontal">
        <Radio label="Stream" value="stream" />
        <Radio label="Buffer" value="buffer" />
      </RadioGroup>
      <RadioGroup defaultValue="checked" layout="horizontal">
        <Radio checked disabled label="Disabled, checked" value="checked" />
      </RadioGroup>
    </Row>
    <Row label="radio group - invalid">
      <Field validationMessage="Pick the protocol this upstream speaks." validationState="error">
        <RadioGroup layout="horizontal">
          <Radio label="Chat Completions" value="chat" />
          <Radio label="Responses" value="responses" />
        </RadioGroup>
      </Field>
    </Row>
  </Section>;
}

function SwitchSection() {
  return <Section id="switch" title="Switch">
    <Hint>Hover, press and tab across the switches to reach hover, pressed and focus-visible in both positions.</Hint>
    <Row label="unchecked and checked">
      <Switch checked={false} label="Enable streaming" onChange={() => {}} />
      <Switch checked label="Enable streaming" onChange={() => {}} />
    </Row>
    <Row label="disabled">
      <Switch checked={false} disabled label="Disabled, off" />
      <Switch checked disabled label="Disabled, on" />
    </Row>
    <Row label="label position">
      <Switch defaultChecked label="Above" labelPosition="above" />
      <Switch defaultChecked label="Before" labelPosition="before" />
      <Switch defaultChecked label="After" labelPosition="after" />
    </Row>
  </Section>;
}

function SelectSection() {
  return <Section id="select" title="Dropdown and combobox">
    <Hint>Open a list to see the option hover, pressed and selected states; tab into a closed control for focus-visible.</Hint>
    <Row label="dropdown">
      <StateLabel state="rest">
        <Dropdown placeholder="Pick an upstream">
          <Option text="GitHub Copilot" value="copilot">GitHub Copilot</Option>
          <Option text="Azure AI Foundry" value="azure">Azure AI Foundry</Option>
          <Option disabled text="Ollama (offline)" value="ollama">Ollama (offline)</Option>
        </Dropdown>
      </StateLabel>
      <StateLabel state="selected value">
        <Dropdown defaultSelectedOptions={['copilot']} defaultValue="GitHub Copilot">
          <Option text="GitHub Copilot" value="copilot">GitHub Copilot</Option>
          <Option text="Azure AI Foundry" value="azure">Azure AI Foundry</Option>
        </Dropdown>
      </StateLabel>
      <StateLabel state="disabled">
        <Dropdown disabled defaultValue="GitHub Copilot">
          <Option text="GitHub Copilot" value="copilot">GitHub Copilot</Option>
        </Dropdown>
      </StateLabel>
      <StateLabel state="invalid">
        <Field validationMessage="Choose the upstream this alias routes to." validationState="error">
          <Dropdown placeholder="Pick an upstream">
            <Option text="GitHub Copilot" value="copilot">GitHub Copilot</Option>
          </Dropdown>
        </Field>
      </StateLabel>
    </Row>
    <Row label="dropdown - multiselect">
      <Dropdown multiselect defaultSelectedOptions={['chat', 'responses']} placeholder="Endpoints">
        <Option text="Chat Completions" value="chat">Chat Completions</Option>
        <Option text="Responses" value="responses">Responses</Option>
        <Option text="Embeddings" value="embeddings">Embeddings</Option>
      </Dropdown>
    </Row>
    <Row label="combobox">
      <StateLabel state="rest"><Combobox placeholder="Filter models">
        <Option text="claude-sonnet-4.5" value="claude-sonnet-4.5">claude-sonnet-4.5</Option>
        <Option text="gpt-5-codex" value="gpt-5-codex">gpt-5-codex</Option>
      </Combobox></StateLabel>
      <StateLabel state="disabled"><Combobox disabled defaultValue="gpt-5-codex">
        <Option text="gpt-5-codex" value="gpt-5-codex">gpt-5-codex</Option>
      </Combobox></StateLabel>
      <StateLabel state="freeform"><Combobox freeform placeholder="Type a model id">
        <Option text="gpt-5-codex" value="gpt-5-codex">gpt-5-codex</Option>
      </Combobox></StateLabel>
    </Row>
  </Section>;
}

function FieldSection() {
  return <Section id="field" title="Field">
    <Hint>Tab into each wrapped control to see the field label keep its colour while the control takes focus.</Hint>
    <Row label="validation states">
      <StateLabel state="rest">
        <Field hint="Shown in the upstream list." label="Display name">
          <Input defaultValue="Copilot (work)" />
        </Field>
      </StateLabel>
      <StateLabel state="error">
        <Field label="Base URL" validationMessage="Enter an absolute https:// URL." validationState="error">
          <Input defaultValue="api.githubcopilot" />
        </Field>
      </StateLabel>
      <StateLabel state="warning">
        <Field label="Request timeout" validationMessage="Above 120 s the Worker may cut the stream." validationState="warning">
          <Input defaultValue="180" />
        </Field>
      </StateLabel>
      <StateLabel state="success">
        <Field label="API key" validationMessage="Credential verified." validationState="success">
          <Input defaultValue="sk-floway-…" />
        </Field>
      </StateLabel>
    </Row>
    <Row label="disabled and sizes">
      <Field label="Small" size="small"><Input defaultValue="4096" /></Field>
      <Field label="Medium" size="medium"><Input defaultValue="4096" /></Field>
      <Field label="Large" size="large"><Input defaultValue="4096" /></Field>
      <Field hint="Managed by the provider." label="Disabled">
        <Input defaultValue="4096" disabled />
      </Field>
    </Row>
    <Row label="hint carrying a link">
      <Field hint={<>See <Link href="#nav">the proxy documentation</Link> for the accepted schemes.</>} label="Proxy URI">
        <Input defaultValue="socks5://127.0.0.1:1080" />
      </Field>
    </Row>
  </Section>;
}

const cardAppearances = ['filled', 'filled-alternative', 'outline', 'subtle'] as const;

function CardSection() {
  return <Section id="card" title="Card">
    <Hint>Hover and press a card, and tab to a selectable one, to reach hover, pressed and focus-visible.</Hint>
    <Row label="appearances">
      {cardAppearances.map(appearance => <StateLabel key={appearance} state={appearance}>
        <Card appearance={appearance} className="w-[220px]">
          <CardHeader
            description={<Text size={200} className="text-fui-fg2">12 models, 2 aliases</Text>}
            header={<Text weight="semibold">Copilot (work)</Text>}
            image={<ServerRegular fontSize={24} />}
          />
        </Card>
      </StateLabel>)}
    </Row>
    <Row label="sizes and orientation">
      <Card className="w-[200px]" size="small"><Text>Small</Text></Card>
      <Card className="w-[200px]" size="medium"><Text>Medium</Text></Card>
      <Card className="w-[200px]" size="large"><Text>Large</Text></Card>
      <Card className="w-[260px]" orientation="horizontal">
        <ServerRegular fontSize={24} />
        <Text>Horizontal - 4 upstreams online</Text>
      </Card>
    </Row>
  </Section>;
}

function DialogSection() {
  return <Section id="dialog" title="Dialog">
    <Hint>Open a dialog to judge the surface, its title row and the action strip; hover and tab inside it for the button states.</Hint>
    <Row label="modal, non-modal and alert">
      <Dialog>
        <DialogTrigger disableButtonEnhancement>
          <Button>Delete upstream (modal)</Button>
        </DialogTrigger>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete “Copilot (work)”?</DialogTitle>
            <DialogContent>
              <Text>Aliases pointing at this upstream stop resolving. Recorded usage is kept.</Text>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary">Delete</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog modalType="non-modal">
        <DialogTrigger disableButtonEnhancement>
          <Button>Rotate key (non-modal)</Button>
        </DialogTrigger>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Rotate API key</DialogTitle>
            <DialogContent>
              <Field label="Key name"><Input defaultValue="codex-cli" /></Field>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary">Rotate</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog modalType="alert">
        <DialogTrigger disableButtonEnhancement>
          <Button>Restore backup (alert)</Button>
        </DialogTrigger>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Restore overwrites this instance</DialogTitle>
            <DialogContent>
              <Text>Every upstream, alias and API key is replaced by the contents of the dump.</Text>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary">Restore</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Row>
  </Section>;
}

function PopoverSection() {
  return <Section id="popover" title="Popover">
    <Hint>Open each popover; the trigger's own pressed and focus-visible states come from the button underneath it.</Hint>
    <Row label="sizes and appearances">
      <Popover>
        <PopoverTrigger disableButtonEnhancement>
          <Button>Small</Button>
        </PopoverTrigger>
        <PopoverSurface><Text>Usage is aggregated hourly.</Text></PopoverSurface>
      </Popover>
      <Popover size="medium">
        <PopoverTrigger disableButtonEnhancement>
          <Button>Medium</Button>
        </PopoverTrigger>
        <PopoverSurface>
          <Text block weight="semibold">Model alias</Text>
          <Text block>An alias exposes one public model id and resolves it across upstream candidates.</Text>
        </PopoverSurface>
      </Popover>
      <Popover size="large">
        <PopoverTrigger disableButtonEnhancement>
          <Button>Large</Button>
        </PopoverTrigger>
        <PopoverSurface>
          <Text block weight="semibold">Proxy</Text>
          <Text block>Requests to this upstream are dialled through the selected proxy.</Text>
        </PopoverSurface>
      </Popover>
      <Popover appearance="brand">
        <PopoverTrigger disableButtonEnhancement>
          <Button>Brand</Button>
        </PopoverTrigger>
        <PopoverSurface><Text>Floway keeps the upstream response verbatim.</Text></PopoverSurface>
      </Popover>
      <Popover appearance="inverted">
        <PopoverTrigger disableButtonEnhancement>
          <Button>Inverted</Button>
        </PopoverTrigger>
        <PopoverSurface><Text>Floway keeps the upstream response verbatim.</Text></PopoverSurface>
      </Popover>
      <Popover>
        <PopoverTrigger disableButtonEnhancement>
          <Button disabled>Disabled trigger</Button>
        </PopoverTrigger>
        <PopoverSurface><Text>Unreachable while the trigger is disabled.</Text></PopoverSurface>
      </Popover>
    </Row>
  </Section>;
}

function MenuSection() {
  return <Section id="menu" title="Menu">
    <Hint>Open a menu and move the pointer or arrow keys through it for the item hover, pressed and focus states.</Hint>
    <Row label="items, icons, dividers and a submenu">
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button appearance="subtle" aria-label="Upstream actions" icon={<MoreHorizontalRegular />} />
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<ArrowClockwiseRegular />}>Refresh models</MenuItem>
            <MenuItem icon={<DocumentRegular />}>Duplicate</MenuItem>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <MenuItem>Export as</MenuItem>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem>JSON dump</MenuItem>
                  <MenuItem>Agent Setup script</MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
            <MenuDivider />
            <MenuItem disabled icon={<DeleteRegular />}>Delete (in use)</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      <Menu checkedValues={{ protocol: ['responses'], stream: ['on'] }} onCheckedValueChange={() => {}}>
        <MenuTrigger disableButtonEnhancement>
          <Button>Checked items</Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItemRadio name="protocol" value="chat">Chat Completions</MenuItemRadio>
            <MenuItemRadio name="protocol" value="responses">Responses</MenuItemRadio>
            <MenuDivider />
            <MenuItemCheckbox name="stream" value="on">Stream the response</MenuItemCheckbox>
            <MenuItemCheckbox disabled name="stream" value="usage">Include usage (disabled)</MenuItemCheckbox>
          </MenuList>
        </MenuPopover>
      </Menu>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button>Split into groups</Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuGroup>
              <MenuGroupHeader>Upstreams</MenuGroupHeader>
              <MenuItem>GitHub Copilot</MenuItem>
              <MenuItem>Azure AI Foundry</MenuItem>
            </MenuGroup>
            <MenuDivider />
            <MenuGroup>
              <MenuGroupHeader>Aliases</MenuGroupHeader>
              <MenuItem>gpt-5-codex</MenuItem>
            </MenuGroup>
          </MenuList>
        </MenuPopover>
      </Menu>
    </Row>
  </Section>;
}

function TooltipSection() {
  return <Section id="tooltip" title="Tooltip">
    <Hint>Hover or tab onto each trigger and wait for the tooltip; it cannot be pinned open from props.</Hint>
    <Row label="positions and relationships">
      <Tooltip content="Refresh the model catalog" relationship="label">
        <Button aria-label="Refresh models" icon={<ArrowClockwiseRegular />} />
      </Tooltip>
      <Tooltip content="Copies the full key once; Floway never shows it again." relationship="description">
        <Button>Copy API key</Button>
      </Tooltip>
      <Tooltip content="Above" positioning="above" relationship="description">
        <Button>Above</Button>
      </Tooltip>
      <Tooltip content="After" positioning="after" relationship="description">
        <Button>After</Button>
      </Tooltip>
      <Tooltip content="Below" positioning="below" relationship="description">
        <Button>Below</Button>
      </Tooltip>
      <Tooltip content="Still reachable while the button is disabledFocusable" relationship="description">
        <Button disabledFocusable>Disabled trigger</Button>
      </Tooltip>
    </Row>
  </Section>;
}

function DrawerSection() {
  const [open, setOpen] = useState(false);

  return <Section id="drawer" title="Drawer">
    <Hint>The overlay drawer opens over a scrim; the inline drawer below shares the same surface without one.</Hint>
    <Row label="overlay drawer - both sides">
      <Button onClick={() => setOpen(true)}>Open overlay drawer</Button>
      <OverlayDrawer open={open} position="end" onOpenChange={(_, data) => setOpen(data.open)}>
        <DrawerHeader>
          <DrawerHeaderTitle
            action={<Button appearance="subtle" aria-label="Close" icon={<DismissRegular />} onClick={() => setOpen(false)} />}
          >Request detail</DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <Text>POST /v1/chat/completions, gpt-5-codex, 1 842 prompt tokens</Text>
        </DrawerBody>
      </OverlayDrawer>
    </Row>
    <Row label="inline drawer - open and closed">
      <div className="relative flex h-[180px] w-full overflow-hidden rounded-lg border border-solid border-[var(--colorNeutralStroke2)]">
        <InlineDrawer open position="start" separator>
          <DrawerHeader><DrawerHeaderTitle>Filters</DrawerHeaderTitle></DrawerHeader>
          <DrawerBody>
            <Checkbox defaultChecked label="Errors only" />
            <Checkbox label="Streaming only" />
          </DrawerBody>
        </InlineDrawer>
        <div className="grid flex-1 place-items-center">
          <Text className="text-fui-fg2">Page content beside an open inline drawer</Text>
        </div>
      </div>
    </Row>
  </Section>;
}

function NavSection() {
  return <Section id="nav" title="Navigation">
    <Hint>Hover and tab through the items; “Requests” is the selected one, and the category can be collapsed and expanded.</Hint>
    <Row label="inline nav drawer">
      <NavDrawer defaultSelectedValue="requests" defaultSelectedCategoryValue="monitor" open type="inline" className="!h-[380px]">
        <NavDrawerBody>
          <NavSectionHeader>Providers</NavSectionHeader>
          <NavItem icon={<ServerRegular />} value="upstreams">Upstreams</NavItem>
          <NavItem icon={<DocumentRegular />} value="aliases">Model aliases</NavItem>
          <NavItem disabled icon={<KeyRegular />} value="proxy">Proxy (disabled)</NavItem>
          <NavSectionHeader>Monitor</NavSectionHeader>
          <NavCategory value="monitor">
            <NavCategoryItem icon={<DocumentRegular />}>Telemetry</NavCategoryItem>
            <NavSubItemGroup>
              <NavSubItem value="requests">Requests</NavSubItem>
              <NavSubItem value="usage">Usage</NavSubItem>
              <NavSubItem value="performance">Performance</NavSubItem>
            </NavSubItemGroup>
          </NavCategory>
        </NavDrawerBody>
      </NavDrawer>
    </Row>
  </Section>;
}

function TabsSection() {
  return <Section id="tabs" title="Tabs">
    <Hint>Hover and tab across each list; the selected tab carries the WinUI indicator, and one tab is disabled.</Hint>
    <Row label="horizontal - sizes">
      <TabList aria-label="Small tabs" defaultSelectedValue="request" size="small">
        <Tab value="request">Request</Tab>
        <Tab value="response">Response</Tab>
        <Tab disabled value="trace">Trace</Tab>
      </TabList>
      <TabList aria-label="Medium tabs" defaultSelectedValue="request" size="medium">
        <Tab value="request">Request</Tab>
        <Tab value="response">Response</Tab>
        <Tab disabled value="trace">Trace</Tab>
      </TabList>
      <TabList aria-label="Large tabs" defaultSelectedValue="request" size="large">
        <Tab value="request">Request</Tab>
        <Tab value="response">Response</Tab>
        <Tab disabled value="trace">Trace</Tab>
      </TabList>
    </Row>
    <Row label="subtle-circular appearance, icons, and vertical">
      <TabList appearance="subtle-circular" aria-label="Subtle circular tabs with icons" defaultSelectedValue="request">
        <Tab icon={<DocumentRegular />} value="request">Request</Tab>
        <Tab icon={<ServerRegular />} value="response">Response</Tab>
      </TabList>
      <TabList appearance="filled-circular" aria-label="Filled circular tabs" defaultSelectedValue="request">
        <Tab value="request">Request</Tab>
        <Tab value="response">Response</Tab>
      </TabList>
      <TabList aria-label="Vertical tabs" defaultSelectedValue="usage" vertical>
        <Tab value="usage">Usage</Tab>
        <Tab value="performance">Performance</Tab>
        <Tab disabled value="errors">Errors</Tab>
      </TabList>
    </Row>
  </Section>;
}

function AccordionSection() {
  return <Section id="accordion" title="Accordion">
    <Hint>Click a header to collapse or expand it; hover and tab across the headers for their own states.</Hint>
    <Row label="collapsed, expanded, disabled">
      <Accordion collapsible defaultOpenItems="credentials" className="!w-full">
        <AccordionItem value="credentials">
          <AccordionHeader>Credentials</AccordionHeader>
          <AccordionPanel>
            <Field label="API key"><Input defaultValue="sk-floway-…" /></Field>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem value="routing">
          <AccordionHeader>Routing and fallbacks</AccordionHeader>
          <AccordionPanel>
            <Text>Candidates are tried in order until one accepts the request.</Text>
          </AccordionPanel>
        </AccordionItem>
        <AccordionItem disabled value="billing">
          <AccordionHeader>Pricing overrides (no rate card)</AccordionHeader>
          <AccordionPanel><Text>Unavailable.</Text></AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Row>
    <Row label="multiple open">
      <Accordion multiple defaultOpenItems={['a', 'b']} className="!w-full">
        <AccordionItem value="a">
          <AccordionHeader>Upstream health</AccordionHeader>
          <AccordionPanel><Text>4 upstreams online.</Text></AccordionPanel>
        </AccordionItem>
        <AccordionItem value="b">
          <AccordionHeader>Model catalog</AccordionHeader>
          <AccordionPanel><Text>12 models addressable.</Text></AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Row>
  </Section>;
}

const messageBarIntents = ['info', 'success', 'warning', 'error'] as const;

function MessageBarSection() {
  return <Section id="message-bar" title="Message bar">
    <Hint>Hover and tab onto the actions inside each bar for their button states.</Hint>
    {messageBarIntents.map(intent => <Row key={intent} label={intent}>
      <MessageBar intent={intent} className="!w-full">
        <MessageBarBody>
          <MessageBarTitle>Model catalog</MessageBarTitle>
          Copilot returned 12 models; 2 of them are not addressable by any alias.
        </MessageBarBody>
        <MessageBarActions
          containerAction={<Button appearance="transparent" aria-label="Dismiss" icon={<DismissRegular />} />}
        >
          <Button size="small">Review aliases</Button>
        </MessageBarActions>
      </MessageBar>
    </Row>)}
    <Row label="layouts">
      <MessageBar intent="warning" layout="singleline" className="!w-full">
        <MessageBarBody>Usage rows older than 90 days are pruned nightly.</MessageBarBody>
      </MessageBar>
      <MessageBar intent="error" layout="multiline" className="!w-full">
        <MessageBarBody>
          <MessageBarTitle>Upstream refused the request</MessageBarTitle>
          HTTP 401 from api.githubcopilot.com. The stored credential no longer authenticates.
        </MessageBarBody>
        <MessageBarActions><Button size="small">Re-authenticate</Button></MessageBarActions>
      </MessageBar>
    </Row>
    <Row label="several messages">
      <OutcomeMessageBar className="!w-full" intent="warning">
        <Text>No pricing rule matches gpt-5-codex, so its requests are recorded without a cost.</Text>
        <Text>Two rules select the same coordinate; the later one never applies.</Text>
      </OutcomeMessageBar>
    </Row>
  </Section>;
}

function ProgressSection() {
  return <Section id="progress" title="Progress">
    <Hint>The indeterminate bar and the spinners animate on their own; no state here needs the pointer.</Hint>
    <Row label="progress bar - determinate values">
      <div className="grid w-[240px] gap-3">
        <ProgressBar value={0} />
        <ProgressBar value={0.35} />
        <ProgressBar value={1} />
        <ProgressBar />
      </div>
      <Text size={200} className="text-fui-fg2">0 %, 35 %, 100 %, indeterminate</Text>
    </Row>
    <Row label="progress bar - thickness and intent">
      <div className="grid w-[240px] gap-3">
        <ProgressBar thickness="medium" value={0.6} />
        <ProgressBar thickness="large" value={0.6} />
        <ProgressBar color="success" value={0.6} />
        <ProgressBar color="warning" value={0.6} />
        <ProgressBar color="error" value={0.6} />
      </div>
    </Row>
    <Row label="spinner - sizes">
      <Spinner size="tiny" />
      <Spinner size="extra-small" />
      <Spinner size="small" />
      <Spinner size="medium" />
      <Spinner size="large" />
      <Spinner size="huge" />
    </Row>
    <Row label="spinner - appearance and label">
      <Spinner label="Refreshing the model catalog…" />
      <Spinner labelPosition="after" label="Saving" />
      <div className="rounded-md p-3" style={{ background: 'var(--colorNeutralBackgroundInverted)' }}>
        <Spinner appearance="inverted" label="On an inverted surface" />
      </div>
    </Row>
  </Section>;
}

const toastIntents = ['info', 'success', 'warning', 'error'] as const;

// Long enough to hover a bar mid-depletion and watch it hold.
const TOAST_TIMEOUT_MS = 8000;
const TOAST_SETTLE_MS = 1500;
const TOAST_LIMIT = 3;

const wrappingBody = 'The catalog came back with 128 models. 12 of them declare an endpoint set no protocol here speaks, 3 are addressable only through an alias another upstream already claims, and the rest were recorded against the prices published at the moment of the fetch.';
const wrappingTitle = 'The upstream catalog refresh could not reach api.githubcopilot.com';
const unbrokenToken = 'https://models.inference.example.invalid/v2/deployments/gpt-5-codex-preview-2026-07-31-eastus2-provisioned/chat/completions';

function ToastSection() {
  const toasterId = useFluentId('winui-gallery-toaster');
  const { dismissToast, dispatchToast, updateToast } = useToastController(toasterId);
  const sequence = useRef(0);
  const stacked = useRef<string[]>([]);

  const fire = (content: React.ReactNode, intent?: (typeof toastIntents)[number]) => {
    const toastId = `${toasterId}-${sequence.current++}`;
    dispatchToast(content, { intent, timeout: TOAST_TIMEOUT_MS, toastId });
    return toastId;
  };

  const saved = <Toast>
    <ToastTitle action={<Button appearance="transparent" size="small">Undo</Button>}>Upstream saved</ToastTitle>
    <ToastBody subtitle="Copilot (work)">12 models are now addressable.</ToastBody>
    <ToastFooter><Link>Open the upstream</Link></ToastFooter>
  </Toast>;

  const firePending = () => {
    const toastId = `${toasterId}-${sequence.current++}`;
    dispatchToast(
      <Toast><ToastTitle media={<Spinner size="tiny" />}>Saving the upstream…</ToastTitle></Toast>,
      { timeout: -1, toastId },
    );
    setTimeout(() => updateToast({
      content: <Toast><ToastTitle>Upstream saved</ToastTitle></Toast>,
      intent: 'success',
      timeout: TOAST_TIMEOUT_MS,
      toastId,
    }), TOAST_SETTLE_MS);
  };

  const fireStack = () => {
    stacked.current = ['Oldest, at the bottom', 'The middle one', 'Newest, on top'].map((title, index) => fire(
      <Toast><ToastTitle>{title}</ToastTitle></Toast>,
      toastIntents[index],
    ));
  };

  return <Section id="toast" title="Toast">
    <Hint>Toasts are transient, so each case is fired on demand. This toaster holds {TOAST_LIMIT} at once and queues the rest, and each toast runs for {TOAST_TIMEOUT_MS / 1000} seconds - hover one to hold its bar where it is, and leave it to carry on from there rather than start again.</Hint>
    <Toaster limit={TOAST_LIMIT} position="top-end" toasterId={toasterId} />
    <Row label="intents">
      {toastIntents.map(intent => <Button key={intent} onClick={() => fire(saved, intent)}>Fire {intent}</Button>)}
    </Row>
    <Row label="layouts">
      <Button onClick={() => fire(<Toast><ToastTitle>Model catalog refreshed</ToastTitle></Toast>, 'success')}>
        Title only
      </Button>
      <Button onClick={() => fire(
        <Toast><ToastTitle>Model catalog refreshed</ToastTitle><ToastBody>128 models are addressable.</ToastBody></Toast>,
        'success',
      )}>One line each</Button>
      <Button onClick={() => fire(
        <Toast><ToastTitle>Model catalog refreshed</ToastTitle><ToastBody>{wrappingBody}</ToastBody></Toast>,
        'warning',
      )}>Wrapping body</Button>
      <Button onClick={() => fire(
        <Toast><ToastTitle>{wrappingTitle}</ToastTitle></Toast>,
        'error',
      )}>Wrapping title only</Button>
      <Button onClick={() => fire(
        <Toast><ToastTitle>{wrappingTitle}</ToastTitle><ToastBody>Retrying in 30 seconds.</ToastBody></Toast>,
        'error',
      )}>Wrapping title</Button>
      <Button onClick={() => fire(
        <Toast><ToastTitle>Upstream refused the request</ToastTitle><ToastBody>{unbrokenToken}</ToastBody></Toast>,
        'error',
      )}>Unbroken token</Button>
    </Row>
    <Hint>The wrapped title is the case the severity mark&apos;s margin exists for: the glyph pins to the first line instead of centring in the row it shares with the title. The body has a grid row of its own below that one, so it cannot move the mark however far it wraps.</Hint>
    <Row label="pending settling into a result">
      <Button onClick={firePending}>Save an upstream</Button>
    </Row>
    <Row label="a stack, and what leaves it">
      <Button onClick={fireStack}>Fire three</Button>
      <Button onClick={() => dismissToast(stacked.current[1])}>Dismiss the middle one</Button>
      <Button onClick={() => Array.from({ length: TOAST_LIMIT + 2 }, (_, index) => fire(
        <Toast><ToastTitle>Queued behind the limit, number {index + 1}</ToastTitle></Toast>,
        'info',
      ))}>Fire past the limit</Button>
    </Row>
  </Section>;
}

const requestRows = [
  { latency: '1.2 s', model: 'gpt-5-codex', status: '200', tokens: '1 842' },
  { latency: '0.4 s', model: 'claude-sonnet-4.5', status: '200', tokens: '612' },
  { latency: '8.9 s', model: 'gpt-5-codex', status: '429', tokens: '0' },
];

function TableSection() {
  return <Section id="table" title="Table">
    <Hint>Hover a row and tab through the selection cells; the second row is selected and the last one is disabled.</Hint>
    <Row label="selectable rows, sortable header">
      <Table sortable>
        <TableHeader>
          <TableRow>
            <TableSelectionCell checked="mixed" />
            <TableHeaderCell sortDirection="ascending">Model</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Tokens</TableHeaderCell>
            <TableHeaderCell>Latency</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requestRows.map((row, index) => <TableRow
            key={row.model + row.latency}
            appearance={index === 1 ? 'brand' : 'none'}
          >
            <TableSelectionCell checked={index === 1} checkboxIndicator={{ disabled: index === 2 }} />
            <TableCell>{row.model}</TableCell>
            <TableCell>{row.status}</TableCell>
            <TableCell>{row.tokens}</TableCell>
            <TableCell>{row.latency}</TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </Row>
    <Row label="row appearances and sizes">
      <Table size="extra-small">
        <TableBody>
          <TableRow appearance="none"><TableCell>none</TableCell><TableCell>extra-small row height</TableCell></TableRow>
          <TableRow appearance="neutral"><TableCell>neutral</TableCell><TableCell>gpt-5-codex</TableCell></TableRow>
          <TableRow appearance="brand"><TableCell>brand</TableCell><TableCell>claude-sonnet-4.5</TableCell></TableRow>
        </TableBody>
      </Table>
    </Row>
  </Section>;
}

function ListSection() {
  return <Section id="list" title="List">
    <Hint>Hover and arrow through the navigable list; selection is driven by the checkboxes in the selectable one.</Hint>
    <Row label="selectable list">
      <List className="!w-full" selectionMode="multiselect" defaultSelectedItems={['copilot']}>
        <ListItem value="copilot" aria-label="Copilot (work)">
          <div className="flex w-full items-center gap-3">
            <ServerRegular />
            <Text>Copilot (work)</Text>
            <StatusBadge tone="success" className="!ml-auto">Online</StatusBadge>
          </div>
        </ListItem>
        <ListItem value="azure" aria-label="Azure AI Foundry">
          <div className="flex w-full items-center gap-3">
            <ServerRegular />
            <Text>Azure AI Foundry</Text>
            <StatusBadge tone="warning" className="!ml-auto">Degraded</StatusBadge>
          </div>
        </ListItem>
        <ListItem value="ollama" aria-label="Ollama (local)">
          <div className="flex w-full items-center gap-3">
            <ServerRegular />
            <Text>Ollama (local)</Text>
            <StatusBadge tone="danger" className="!ml-auto">Offline</StatusBadge>
          </div>
        </ListItem>
      </List>
    </Row>
    <Row label="navigable list, and a plain static list">
      <List className="w-[280px]" navigationMode="items">
        <ListItem value="requests" onAction={() => {}}>Requests</ListItem>
        <ListItem value="usage" onAction={() => {}}>Usage</ListItem>
        <ListItem value="performance" onAction={() => {}}>Performance</ListItem>
      </List>
      <List className="w-[280px]">
        <ListItem>gpt-5-codex</ListItem>
        <ListItem>claude-sonnet-4.5</ListItem>
        <ListItem>text-embedding-3-large</ListItem>
      </List>
    </Row>
  </Section>;
}

const badgeColors = ['brand', 'danger', 'important', 'informative', 'severe', 'subtle', 'success', 'warning'] as const;
const badgeAppearances = ['filled', 'ghost', 'outline', 'tint'] as const;

function BadgeTagSection() {
  return <Section id="badge-tag" title="Badge and tag">
    <Hint>Badges are static; hover, press and tab across the interaction tags for their own states.</Hint>
    {badgeAppearances.map(appearance => <Row key={appearance} label={`badge - ${appearance}`}>
      {badgeColors.map(color => <Badge key={color} appearance={appearance} color={color}>{color}</Badge>)}
    </Row>)}
    <Row label="badge - sizes and shapes">
      <Badge size="tiny">tiny</Badge>
      <Badge size="small">small</Badge>
      <Badge size="medium">medium</Badge>
      <Badge size="large">large</Badge>
      <Badge shape="rounded">rounded</Badge>
      <Badge shape="square">square</Badge>
      <CounterBadge count={12} />
      <CounterBadge count={0} showZero />
      <CounterBadge dot />
    </Row>
    <Row label="tag - rest, dismissible and disabled">
      <Tag>copilot</Tag>
      <Tag appearance="brand">responses</Tag>
      <Tag appearance="outline">embeddings</Tag>
      <Tag appearance="filled">rerank</Tag>
      <Tag disabled>archived</Tag>
      <Tag dismissible dismissIcon={{ 'aria-label': 'Remove tag' }}>gpt-5-codex</Tag>
      <Tag shape="circular" icon={<ServerRegular />}>Copilot (work)</Tag>
      <Tag size="extra-small">small</Tag>
    </Row>
    <Row label="interaction tag - selectable primary with a secondary dismiss">
      <InteractionTag>
        <InteractionTagPrimary hasSecondaryAction>gpt-5-codex</InteractionTagPrimary>
        <InteractionTagSecondary aria-label="Remove gpt-5-codex" />
      </InteractionTag>
      <InteractionTag appearance="brand">
        <InteractionTagPrimary hasSecondaryAction>claude-sonnet-4.5</InteractionTagPrimary>
        <InteractionTagSecondary aria-label="Remove claude-sonnet-4.5" />
      </InteractionTag>
      <InteractionTag appearance="outline">
        <InteractionTagPrimary>text-embedding-3-large</InteractionTagPrimary>
      </InteractionTag>
      <InteractionTag disabled>
        <InteractionTagPrimary hasSecondaryAction>archived alias</InteractionTagPrimary>
        <InteractionTagSecondary aria-label="Remove archived alias" />
      </InteractionTag>
    </Row>
  </Section>;
}

const textSizes = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] as const;

function TextSection() {
  return <Section id="text" title="Text and divider">
    <Hint>Hover and tab onto the links for their hover, pressed and focus-visible states.</Hint>
    <Row label="ramp">
      <div className="grid gap-1">
        {textSizes.map(size => <Text key={size} size={size}>{size} - Requests routed through Floway</Text>)}
      </div>
    </Row>
    <Row label="weights, italic, strikethrough, underline">
      <Text weight="regular">Regular</Text>
      <Text weight="medium">Medium</Text>
      <Text weight="semibold">Semibold</Text>
      <Text weight="bold">Bold</Text>
      <Text italic>Italic</Text>
      <Text strikethrough>Strikethrough</Text>
      <Text underline>Underline</Text>
      <Text className="font-mono" font="monospace">gpt-5-codex</Text>
      <Text font="numeric">1 842 tokens</Text>
    </Row>
    <Row label="link">
      <Link href="#button">Link</Link>
      <Link appearance="subtle" href="#card">Subtle link</Link>
      <Link disabled>Disabled link</Link>
      <Link disabled disabledFocusable>Disabled, focusable link</Link>
    </Row>
    <Row label="divider">
      <div className="grid w-full gap-4">
        <Divider />
        <Divider>Advanced</Divider>
        <Divider alignContent="start">Credentials</Divider>
        <Divider alignContent="end">Danger zone</Divider>
        <Divider appearance="subtle">Subtle</Divider>
        <Divider appearance="strong">Strong</Divider>
        <Divider appearance="brand">Brand</Divider>
        <Divider inset>Inset</Divider>
        <div className="h-[60px]"><Divider vertical /></div>
      </div>
    </Row>
  </Section>;
}

function ToolbarSection() {
  return <Section id="toolbar" title="Toolbar">
    <Hint>Hover, press and arrow through the toolbar; “Wrap lines” is the checked toggle and one button is disabled.</Hint>
    <Row label="sizes, groups and orientation">
      <Toolbar aria-label="Request actions" checkedValues={{ view: ['wrap'] }} onCheckedValueChange={() => {}}>
        <ToolbarButton appearance="primary" icon={<AddRegular />}>New upstream</ToolbarButton>
        <ToolbarButton icon={<ArrowClockwiseRegular />}>Refresh</ToolbarButton>
        <ToolbarDivider />
        <ToolbarToggleButton icon={<DocumentRegular />} name="view" value="wrap">Wrap lines</ToolbarToggleButton>
        <ToolbarToggleButton icon={<ServerRegular />} name="view" value="raw">Raw body</ToolbarToggleButton>
        <ToolbarDivider />
        <ToolbarButton disabled icon={<DeleteRegular />}>Delete</ToolbarButton>
      </Toolbar>
      <Toolbar aria-label="Request actions, small" size="small">
        <ToolbarGroup role="presentation">
          <ToolbarButton icon={<SaveRegular />}>Save</ToolbarButton>
          <ToolbarButton icon={<ArrowClockwiseRegular />}>Refresh</ToolbarButton>
        </ToolbarGroup>
        <ToolbarDivider />
        <ToolbarGroup role="presentation">
          <ToolbarButton aria-label="More actions" icon={<MoreHorizontalRegular />} />
        </ToolbarGroup>
      </Toolbar>
      <Toolbar aria-label="Request actions, large" size="large" vertical>
        <ToolbarButton icon={<SaveRegular />}>Save</ToolbarButton>
        <ToolbarButton icon={<DeleteRegular />}>Delete</ToolbarButton>
      </Toolbar>
    </Row>
  </Section>;
}

function ColorPickerSection() {
  const [color, setColor] = useState('#0F6CBD');

  return <Section id="color-picker" title="Color picker">
    <Hint>Drag the area and the sliders, and tab onto the swatches, to reach their hover, pressed and focus-visible states.</Hint>
    <Row label="picker - area, hue slider and alpha slider">
      <ColorPicker color={{ h: 206, s: 0.87, v: 0.74 }} onColorChange={() => {}}>
        <ColorArea inputX={{ 'aria-label': 'Saturation' }} inputY={{ 'aria-label': 'Brightness' }} />
        <ColorSlider aria-label="Hue" />
        <AlphaSlider aria-label="Alpha" />
      </ColorPicker>
    </Row>
    <Row label="swatch picker - unselected, selected, disabled">
      <SwatchPicker selectedValue={color} onSelectionChange={(_, data) => setColor(data.selectedValue)}>
        <ColorSwatch color="#0F6CBD" value="#0F6CBD" aria-label="Floway blue" />
        <ColorSwatch color="#107C10" value="#107C10" aria-label="Success green" />
        <ColorSwatch color="#C50F1F" value="#C50F1F" aria-label="Error red" />
        <ColorSwatch disabled color="#8A8886" value="#8A8886" aria-label="Disabled grey" />
        <EmptySwatch value="none" aria-label="No colour" />
      </SwatchPicker>
      <Text size={200} className="text-fui-fg2">Selected: {color}</Text>
    </Row>
  </Section>;
}

export default function DashboardWinuiGallery() {
  return <section className="grid gap-7 min-w-0">
    <DashboardPageHeader
      description="Every control the WinUI override layer restyles, with each appearance variant and the states that props can force. This page follows the operating system colour scheme like the rest of Floway does, so switch light and dark in your OS or browser appearance settings to review the other theme - there is no in-app toggle to build against."
      title="WinUI gallery"
    />
    <ButtonSection />
    <TextInputSection />
    <ChoiceSection />
    <SwitchSection />
    <SelectSection />
    <FieldSection />
    <CardSection />
    <DialogSection />
    <PopoverSection />
    <MenuSection />
    <TooltipSection />
    <DrawerSection />
    <NavSection />
    <TabsSection />
    <AccordionSection />
    <MessageBarSection />
    <ProgressSection />
    <ToastSection />
    <TableSection />
    <ListSection />
    <BadgeTagSection />
    <TextSection />
    <ToolbarSection />
    <ColorPickerSection />
  </section>;
}
