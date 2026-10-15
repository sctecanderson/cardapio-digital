export interface Restaurant {
  slug: string;
  name: string;
  subtitle: string;
  theme: { primary: string; background: string; text: string };
  brandPrimaryColor?: string;
  brand_primary_color?: string;
  headerNameColor?: string;
  header_name_color?: string;
  headerSubtitleColor?: string;
  header_subtitle_color?: string;
}
