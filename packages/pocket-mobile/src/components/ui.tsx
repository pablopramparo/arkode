import { Pressable, Text, View, type PressableProps, type ViewProps } from 'react-native';
import { theme } from '../lib/theme';

/** A handful of tiny, dependency-free UI primitives — deliberately no component library, this app is small on purpose. */

export function Screen({ children, style, ...rest }: ViewProps) {
  return (
    <View style={[{ flex: 1, backgroundColor: theme.background, padding: 16 }, style]} {...rest}>
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
}: PressableProps & { title: string; variant?: 'primary' | 'ghost' | 'danger' }) {
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
