import { useNavigation } from 'react-router';

export function NavigationProgress() {
  const navigation = useNavigation();
  return <div aria-hidden="true" className="floway-navigation-progress" data-active={navigation.state !== 'idle'} />;
}
