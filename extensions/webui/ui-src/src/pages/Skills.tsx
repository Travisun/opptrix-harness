import { PlaceholderPage } from '@/components/PlaceholderPage';
import { findNavItem } from '@/lib/nav';

export default function SkillsPage() {
  const item = findNavItem('/skills');
  if (!item) return null;
  return <PlaceholderPage item={item} />;
}
