import { Pressable, ScrollView, Text, View, type ScrollViewProps, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '../lib/theme';

/** A handful of tiny, dependency-free UI primitives — deliberately no component library, this app is small on purpose. */

/**
 * The base screen chrome: dark background, horizontal padding, and real
 * safe-area insets (status bar up top, gesture/nav bar at the bottom) —
 * every screen was previously using a flat `padding: 16`, which is why
 * content sat flush against the Android status bar and the last item in a
 * long list could end up hidden behind the system nav bar.
 *
 * `scroll` picks the right container for screens whose own content isn't
 * already a scrolling primitive (FlatList manages its own scrolling and
 * should stay inside the plain, non-scrolling variant — nesting a
 * ScrollView around a FlatList is the classic "VirtualizedLists should
 * never be nested" trap and part of what broke scrolling before).
 */
export function Screen({
  children,
  style,
  scroll = false,
  contentContainerStyle,
  ...rest
}: ViewProps & { scroll?: boolean; contentContainerStyle?: ScrollViewProps['contentContainerStyle'] }) {
  const insets = useSafeAreaInsets();
  const padding = {
    paddingTop: insets.top + 16,
    paddingBottom: insets.bottom + 16,
    paddingHorizontal: 16,
  };
  if (scroll) {
    return (
      <ScrollView
        style={[{ flex: 1, backgroundColor: theme.background }, style as object]}
        contentContainerStyle={[padding, contentContainerStyle]}
      >
        {children}
      </ScrollView>
    );
  }
  return (
    <View style={[{ flex: 1, backgroundColor: theme.background, ...padding }, style]} {...rest}>
      {children}
    </View>
  );
}

export function Card({ children, style, ...rest }: ViewProps) {
  return (
    <View
      style={[{ backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 14 }, style]}
      {...rest}
    >
      {children}
    </View>
  );
}

export function AppButton({
  title,
  variant = 'primary',
  disabled,
  style,
  ...rest
}: React.ComponentProps<typeof Pressable> & { title: string; variant?: 'primary' | 'ghost' | 'danger' }) {
  const bg = variant === 'primary' ? theme.accent : variant === 'danger' ? 'transparent' : 'transparent';
  const borderColor = variant === 'danger' ? theme.danger : variant === 'ghost' ? theme.border : theme.accent;
  const textColor = variant === 'danger' ? theme.danger : variant === 'primary' ? '#fff' : theme.text;
  return (
    <Pressable
      disabled={disabled}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderWidth: 1,
          borderColor,
          borderRadius: 999,
          paddingVertical: 10,
          paddingHorizontal: 18,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
          alignItems: 'center',
        },
        typeof style === 'function' ? undefined : style,
      ]}
      {...rest}
    >
      <Text style={{ color: textColor, fontWeight: '600', fontSize: 15 }}>{title}</Text>
    </Pressable>
  );
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <Text style={{ color: theme.muted, fontSize: 13 }}>{children}</Text>;
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={{ color: theme.text, fontSize: 20, fontWeight: '700', marginBottom: 12 }}>{children}</Text>;
}

/** A comfortable, fully-tappable row for a navigable item (client, credential, URL) — icon, title/subtitle, and a trailing chevron. */
export function NavRow({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.surface,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.border,
        paddingVertical: 12,
        paddingHorizontal: 14,
        marginBottom: 8,
        minHeight: 56,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 20, marginRight: 12 }}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.text, fontWeight: '600', fontSize: 15 }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: theme.muted, fontSize: 13 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Text style={{ color: theme.muted, fontSize: 18, marginLeft: 8 }}>›</Text>
    </Pressable>
  );
}

/** A small section header used to separate groups of NavRows (e.g. "CREDENCIALES" / "URLs"). */
export function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 16, marginBottom: 6 }}>
      <Text style={{ color: theme.muted, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 }}>{title}</Text>
      {count !== undefined && <Text style={{ color: theme.muted, fontSize: 13 }}>{count}</Text>}
    </View>
  );
}
