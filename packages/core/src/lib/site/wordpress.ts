import type { DesignFacts } from "./design-md";

/*
  Build B, 4b1 (27 September 2026): the client's WordPress block theme,
  made in TAWD with no AI from what Build A already has: the site's own
  stylesheet (so blocks carrying Build A's class names look the same) and
  the approved design's colours, fonts, sizes and widths (read by
  readDesign, as for the client's DESIGN.md) as theme.json, so the editor
  offers the client's palette and type. One small theme per client, no
  page builder and no third-party theme. The header and footer are
  template parts in native blocks (made in 4b2); nothing a client typed
  reaches PHP except through the escaping below.
*/

export const WP_THEME_REQUIRES = "6.6";
export const WP_THEME_REQUIRES_PHP = "8.1";

export interface WordPressThemeInput {
  clientName: string;
  /** The Build A version the theme was made from. */
  buildVersion: number;
  /** Build A's site.css, as built. */
  siteCss: string;
  /** Google Fonts <link> tags from the approved design (anything else is dropped). */
  fontLinks: string[];
  design: DesignFacts;
  /** The header and footer as block markup (B1 makes them from Build A's). */
  parts: { header: string; footer: string };
  /** B1: the 404 page's content as block markup. */
  notFound?: string;
  /** B1: Build A's extra head tags on every page (the tracking codes, behind consent), printed as they are. */
  headExtras?: string;
  /** B1: what Build A has after the footer (the consent banner), printed as it is. */
  bodyEnd?: string;
}

/* "Finley Pest Control" → "tawd-finley-pest-control". */
export function themeSlug(clientName: string): string {
  const base = clientName
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `tawd-${base || "client"}`;
}

/* A PHP single-quoted string: backslashes and quotes escaped, nothing else interpreted. */
export function phpString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/* Text safe inside a CSS comment (the theme header). */
const commentSafe = (value: string) => value.replace(/\*\//g, "* /").replace(/[\r\n]+/g, " ");

const FONT_HREF = /^https:\/\/fonts\.googleapis\.com\/css2?\?[\w%&=:;,.+@-]+$/;

/* The href of each Google Fonts link; anything else (or anything odd in it) is dropped. */
export function fontHrefs(fontLinks: string[]): string[] {
  const hrefs = fontLinks
    .map((tag) => /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.replace(/&amp;/g, "&") ?? "")
    .filter((href) => FONT_HREF.test(href));
  return [...new Set(hrefs)];
}

const HEX = /^#[0-9a-f]{6}$/i;

/* The palette: each colour role first (named after it), then the other colours the design uses most. */
export function themePalette(design: DesignFacts): { slug: string; name: string; color: string }[] {
  const out: { slug: string; name: string; color: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, color: string) => {
    const c = color.toLowerCase();
    if (!HEX.test(c) || seen.has(c)) return;
    seen.add(c);
    const slug = name.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    out.push({ slug: slug || `colour-${out.length + 1}`, name, color: c });
  };
  for (const role of design.roles) add(role.role.replace(/\s*\(.*\)$/, ""), role.value);
  for (const [i, entry] of design.palette.entries()) add(`Colour ${i + 1}`, entry.value);
  return out.slice(0, 16);
}

const fontSlug = (family: string) =>
  family
    .split(",")[0]!
    .replace(/["']/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") || "font";

/* theme.json (version 3): the palette, fonts, sizes and widths the approved design uses. */
export function themeJson(design: DesignFacts): Record<string, unknown> {
  const palette = themePalette(design);
  const heading = design.fonts.find((f) => f.role === "Headings")?.family ?? null;
  const body = design.fonts.find((f) => f.role === "Body")?.family ?? null;
  const families = [...new Set([heading, body].filter((f): f is string => Boolean(f)))].map((family) => ({ slug: fontSlug(family), name: family.split(",")[0]!.replace(/["']/g, "").trim(), fontFamily: family }));
  const size = (element: string) => design.sizes.find((s) => s.element === element)?.size;
  const widths = design.maxWidths.filter((w) => /^\d+(\.\d+)?(px|rem|em)$/.test(w));

  return {
    $schema: "https://schemas.wp.org/wp/6.6/theme.json",
    version: 3,
    settings: {
      appearanceTools: true,
      useRootPaddingAwareAlignments: false,
      color: { palette, defaultPalette: false, defaultGradients: false, custom: false },
      typography: {
        fontFamilies: families,
        defaultFontSizes: false,
        fontSizes: ["Body", "H3", "H2", "H1"]
          .map((el) => ({ el, value: size(el) }))
          .filter((f): f is { el: string; value: string } => Boolean(f.value))
          .map((f) => ({ slug: f.el.toLowerCase(), name: f.el === "Body" ? "Body" : `Heading ${f.el.slice(1)}`, size: f.value })),
      },
      layout: { contentSize: widths[0] ?? "1200px", wideSize: widths[1] ?? widths[0] ?? "1200px" },
      // null, not false: WordPress then writes no spacing of its own between blocks (Build A's stylesheet sets it).
      spacing: { blockGap: null, units: ["px", "rem", "%", "vw"] },
    },
    /*
      No colours, fonts or sizes of WordPress's own on the page (1 October 2026): Build A's
      stylesheet, in style.css, already sets them all, and the two would disagree (a heading's
      size on the thank-you page). The palette and fonts above are what the editor offers.
    */
    styles: {
      spacing: { padding: { top: "0", right: "0", bottom: "0", left: "0" } },
    },
    templateParts: [
      { name: "header", title: "Header", area: "header" },
      { name: "footer", title: "Footer", area: "footer" },
    ],
  };
}

/* The page in Build A's own shape: the header, <main id="main"> with the page, the footer. THEME_HOOKS takes WordPress's wrappers off. */
const template = (content: string) => `<!-- wp:template-part {"slug":"header","tagName":"div"} /-->

<!-- wp:group {"tagName":"main","anchor":"main","layout":{"type":"default"}} -->
<main class="wp-block-group" id="main">${content}</main>
<!-- /wp:group -->

<!-- wp:template-part {"slug":"footer","tagName":"div"} /-->
`;
const TEMPLATE = template(`<!-- wp:post-content {"layout":{"type":"default"}} /-->`);

/*
  The theme's hooks (B1, 1 October 2026), the same for every client:
  Build A's shape (no wrappers around the header, the page and the
  footer, the <main> classes), the page's description and business
  details, Build A's tracking codes and consent banner, and Contact
  Form 7 sending people to the thank-you page.
*/
const THEME_HOOKS = String.raw`
// Build A's markup has no wrappers around the header, the page and the footer, so its stylesheet (sticky headers, "main > section") works as it does there.
add_filter('render_block', function ($html, $block) {
	if (!in_array($block['blockName'] ?? '', array('core/post-content', 'core/template-part'), true)) {
		return $html;
	}
	$html = preg_replace('~^\s*<div\b[^>]*>~', '', $html, 1);
	return preg_replace('~</div>\s*$~', '', $html, 1);
}, 10, 2);

// Each page's <main> keeps the classes it has on Build A (".page-home").
add_filter('render_block_core/group', function ($html, $block) {
	if (($block['attrs']['tagName'] ?? '') !== 'main' || !is_singular()) {
		return $html;
	}
	$classes = preg_split('/\s+/', (string) get_post_meta(get_queried_object_id(), '_tawd_main_class', true), -1, PREG_SPLIT_NO_EMPTY);
	if (!$classes) {
		return $html;
	}
	$tags = new WP_HTML_Tag_Processor($html);
	if ($tags->next_tag('main')) {
		foreach ($classes as $class) {
			$tags->add_class($class);
		}
	}
	return $tags->get_updated_html();
}, 10, 2);

// The page's description (Rank Math writes it when it's on) and its business details for search engines; never a rating.
add_action('wp_head', function () {
	if (!is_singular()) {
		return;
	}
	$id = get_queried_object_id();
	$description = (string) get_post_meta($id, 'rank_math_description', true);
	if ($description !== '' && !defined('RANK_MATH_VERSION')) {
		echo '<meta name="description" content="' . esc_attr($description) . '" />' . "\n";
	}
	$schema = (string) get_post_meta($id, '_tawd_schema', true);
	if ($schema !== '') {
		echo '<script type="application/ld+json">' . str_replace('<', '\u003c', $schema) . '</script>' . "\n";
	}
}, 5);

// Build A's own extras: the tracking codes in the head, the consent banner at the end of the page.
add_action('wp_head', function () {
	$file = get_theme_file_path('inc/head.html');
	if (is_readable($file)) {
		echo file_get_contents($file);
	}
}, 20);
add_action('wp_footer', function () {
	$file = get_theme_file_path('inc/body-end.html');
	if (is_readable($file)) {
		echo file_get_contents($file);
	}
});

// F2: each message goes to TAWD, which emails the client from VML's address and checks it arrived. If TAWD doesn't
// answer within 8 seconds, Contact Form 7 emails it as before. A message with a photo keeps WordPress's own email (the file is here).
add_action('wpcf7_before_send_mail', function ($form, &$abort, $submission) {
	if (!defined('TAWD_FORMS_URL') || !defined('TAWD_FORMS_SECRET') || !$submission || $submission->uploaded_files()) {
		return;
	}
	$fields = array();
	foreach ((array) $submission->get_posted_data() as $name => $value) {
		if (strpos((string) $name, '_') === 0) {
			continue;
		}
		$fields[$name] = is_array($value) ? implode(', ', array_map('strval', $value)) : (string) $value;
	}
	$body = wp_json_encode(array('form' => preg_replace('/^TAWD: /', '', $form->title()), 'id' => wp_generate_uuid4(), 'fields' => $fields));
	$at = time();
	$response = wp_remote_post(TAWD_FORMS_URL, array(
		'timeout' => 8,
		'headers' => array('Content-Type' => 'application/json', 'X-Tawd-Signature' => $at . '.' . hash_hmac('sha256', $at . '.' . $body, TAWD_FORMS_SECRET)),
		'body' => $body,
	));
	if (!is_wp_error($response) && (int) wp_remote_retrieve_response_code($response) === 200) {
		add_filter('wpcf7_skip_mail', '__return_true');
	}
}, 10, 3);

// Gravity Forms (when it's the site's form plugin, 1 October 2026): its own styling off, Build A's classes on its fields and button.
add_filter('gform_disable_css', '__return_true');
function tawd_form_look($form_id) {
	$looks = get_option('tawd_form_looks');
	return is_array($looks) && isset($looks[(int) $form_id]) ? (array) $looks[(int) $form_id] : array();
}
function tawd_add_classes($tags, $classes) {
	foreach (preg_split('/\s+/', (string) $classes, -1, PREG_SPLIT_NO_EMPTY) as $class) {
		$tags->add_class($class);
	}
}
add_filter('gform_field_content', function ($content, $field, $value, $lead_id, $form_id) {
	$look = tawd_form_look($form_id);
	if (is_admin() || !$look) {
		return $content;
	}
	$tags = new WP_HTML_Tag_Processor($content);
	while ($tags->next_tag()) {
		$tag = $tags->get_tag();
		$type = strtolower((string) $tags->get_attribute('type'));
		if (in_array($tag, array('INPUT', 'TEXTAREA', 'SELECT'), true) && !in_array($type, array('hidden', 'checkbox', 'radio', 'file'), true)) {
			tawd_add_classes($tags, $look['input'] ?? '');
		} elseif ($tag === 'LABEL') {
			tawd_add_classes($tags, $look['label'] ?? '');
		}
	}
	return $tags->get_updated_html();
}, 10, 5);
add_filter('gform_submit_button', function ($button, $form) {
	$look = tawd_form_look($form['id'] ?? 0);
	if (empty($look['button'])) {
		return $button;
	}
	$tags = new WP_HTML_Tag_Processor($button);
	if ($tags->next_tag()) {
		tawd_add_classes($tags, $look['button']);
	}
	return $tags->get_updated_html();
}, 10, 2);

// F2 with Gravity Forms: each entry goes to TAWD (photos as links); Gravity Forms' own email is the fallback if TAWD doesn't answer.
add_action('gform_entry_created', function ($entry, $form) {
	if (!defined('TAWD_FORMS_URL') || !defined('TAWD_FORMS_SECRET')) {
		return;
	}
	$fields = array();
	$labels = array();
	$files = array();
	foreach ((array) $form['fields'] as $field) {
		$key = $field->inputName ? (string) $field->inputName : 'field_' . $field->id;
		$value = rgar($entry, (string) $field->id);
		if ($field->type === 'fileupload') {
			foreach (array_filter(array_map('trim', explode(',', str_replace(array('[', ']', '"', '\\/'), array('', '', '', '/'), (string) $value)))) as $url) {
				$files[] = array('name' => basename((string) wp_parse_url($url, PHP_URL_PATH)), 'url' => $url);
			}
			continue;
		}
		$fields[$key] = (string) $value;
		$labels[$key] = (string) $field->label;
	}
	$body = wp_json_encode(array('form' => preg_replace('/^TAWD: /', '', (string) $form['title']), 'id' => 'gf-' . $entry['id'], 'fields' => $fields, 'labels' => $labels, 'files' => $files));
	$at = time();
	$response = wp_remote_post(TAWD_FORMS_URL, array(
		'timeout' => 8,
		'headers' => array('Content-Type' => 'application/json', 'X-Tawd-Signature' => $at . '.' . hash_hmac('sha256', $at . '.' . $body, TAWD_FORMS_SECRET)),
		'body' => $body,
	));
	if (!is_wp_error($response) && (int) wp_remote_retrieve_response_code($response) === 200) {
		$GLOBALS['tawd_relayed'][(int) $entry['id']] = true;
	}
}, 10, 2);
add_filter('gform_disable_notification', function ($is_disabled, $notification, $form, $entry) {
	// TAWD's own check never emails anyone, relayed or not (3 October 2026).
	if (!empty($GLOBALS['tawd_checking'])) {
		return true;
	}
	return !empty($GLOBALS['tawd_relayed'][(int) rgar($entry, 'id')]) ? true : $is_disabled;
}, 10, 4);

/*
 * F4 with Gravity Forms (1 October 2026): TAWD's weekly check, signed with the site's own key, goes through Gravity Forms'
 * normal route (its checks, the entry, the relay to TAWD); the test entry is then removed so the client never sees it.
 */
add_action('rest_api_init', function () {
	register_rest_route('tawd/v1', '/check', array(
		'methods' => 'POST',
		'permission_callback' => '__return_true',
		'callback' => function ($request) {
			if (!defined('TAWD_FORMS_SECRET') || !class_exists('GFAPI')) {
				return new WP_Error('tawd_off', 'Form messages do not go through TAWD here.', array('status' => 404));
			}
			$body = (string) $request->get_body();
			$sig = explode('.', (string) $request->get_header('x_tawd_signature'), 2);
			if (count($sig) !== 2 || abs(time() - (int) $sig[0]) > 300 || !hash_equals(hash_hmac('sha256', $sig[0] . '.' . $body, TAWD_FORMS_SECRET), $sig[1])) {
				return new WP_Error('tawd_signature', 'Not signed by TAWD.', array('status' => 403));
			}
			// Each signed check runs once (3 October 2026): a copy sent again inside the five minutes is refused.
			$once = 'tawd_check_' . md5($sig[1]);
			if (get_transient($once)) {
				return new WP_Error('tawd_replay', 'This check was already run.', array('status' => 409));
			}
			set_transient($once, 1, 600);
			$data = json_decode($body, true);
			$message = is_array($data) ? (string) ($data['message'] ?? '') : '';
			if (!preg_match('/^TAWD-HEARTBEAT [A-Za-z0-9_-]{16,64}/', $message)) {
				return new WP_Error('tawd_message', 'Not a TAWD check.', array('status' => 400));
			}
			$form = null;
			foreach (GFAPI::get_forms() as $f) {
				if ($f['title'] === 'TAWD: contact') {
					$form = $f;
					break;
				}
			}
			if (!$form) {
				return new WP_Error('tawd_form', 'There is no TAWD contact form in Gravity Forms.', array('status' => 404));
			}
			// Every field filled the way a visitor would; the check's mark goes in the message box.
			$input = array();
			$text = null;
			foreach ($form['fields'] as $field) {
				$id = 'input_' . $field->id;
				if ($field->type === 'textarea' && $text === null) {
					$text = $id;
				} elseif ($field->type === 'email') {
					$input[$id] = 'forms@velocitymedialab.com';
				} elseif ($field->type === 'phone') {
					$input[$id] = '(555) 555-0100';
				} elseif ($field->type === 'select') {
					$input[$id] = (string) ($field->choices[0]['value'] ?? '');
				} elseif ($field->type === 'consent') {
					$input[$id . '_1'] = '1';
					$input[$id . '_2'] = (string) $field->checkboxLabel;
				} elseif ($field->type === 'number') {
					$input[$id] = '1';
				} elseif ($field->type === 'website') {
					$input[$id] = 'https://velocitymedialab.com';
				} elseif ($field->type === 'date') {
					$input[$id] = gmdate('m/d/Y');
				} elseif ($field->type !== 'fileupload') {
					$input[$id] = 'TAWD weekly check';
				}
			}
			if ($text === null) {
				foreach ($form['fields'] as $field) {
					if ($field->type === 'text') {
						$text = 'input_' . $field->id;
						break;
					}
				}
			}
			if ($text === null) {
				return new WP_Error('tawd_form', 'The form has no box for a message.', array('status' => 422));
			}
			$input[$text] = $message;
			$GLOBALS['tawd_checking'] = true;
			$result = GFAPI::submit_form((int) $form['id'], $input);
			$GLOBALS['tawd_checking'] = false;
			if (is_wp_error($result)) {
				return new WP_Error('tawd_gf', 'Gravity Forms: ' . $result->get_error_message(), array('status' => 500));
			}
			if (empty($result['is_valid'])) {
				return new WP_Error('tawd_gf', 'Gravity Forms refused it: ' . implode(' ', array_map('wp_strip_all_tags', array_values((array) ($result['validation_messages'] ?? array())))), array('status' => 422));
			}
			$relayed = !empty($GLOBALS['tawd_relayed'][(int) $result['entry_id']]);
			GFAPI::delete_entry((int) $result['entry_id']);
			if (!$relayed) {
				return new WP_Error('tawd_relay', 'The check reached Gravity Forms, but the relay to TAWD did not answer, so a real message would have gone only by email.', array('status' => 502));
			}
			return array('ok' => true, 'relayed' => true);
		},
	));
});

/*
 * The header's menu (1 October 2026): WordPress's "Main menu" (Appearance, Menus), drawn in each of Build A's navs
 * in that nav's own markup (install.php keeps it in tawd_menus). Top-level items; with no menu, the pages TAWD built.
 */
add_action('after_setup_theme', function () {
	register_nav_menus(array('primary' => 'Main menu'));
});
add_shortcode('tawd_menu', function ($atts) {
	$atts = shortcode_atts(array('nav' => ''), $atts, 'tawd_menu');
	$looks = get_option('tawd_menus');
	$look = is_array($looks) ? ($looks[$atts['nav']] ?? null) : null;
	if (!is_array($look) || !isset($look['template'])) {
		return '';
	}
	$current = (int) get_queried_object_id();
	$links = array();
	$locations = get_nav_menu_locations();
	$items = empty($locations['primary']) ? array() : (wp_get_nav_menu_items($locations['primary']) ?: array());
	foreach ($items as $item) {
		if ((int) $item->menu_item_parent === 0) {
			$links[] = array($item->url, $item->title, $current && $item->type === 'post_type' && (int) $item->object_id === $current);
		}
	}
	if (!$links && empty($locations['primary'])) {
		foreach ((array) ($looks['_items'] ?? array()) as $item) {
			$links[] = array(home_url($item['path']), $item['label'], $current && get_permalink($current) === home_url($item['path']));
		}
	}
	$out = array();
	foreach ($links as $link) {
		$out[] = str_replace(array('{tawd:current}', '{tawd:href}', '{tawd:label}'), array($link[2] ? ' aria-current="page"' : '', esc_url($link[0]), esc_html($link[1])), $look['template']);
	}
	return implode((string) ($look['gap'] ?? ''), $out);
});

// Contact Form 7: the form's own markup as written (no extra paragraphs), and the thank-you page once a message is sent, as on Build A.
add_filter('wpcf7_autop_or_not', '__return_false');

/*
 * Speed (1 October 2026). Picture blocks get every size TAWD made and how wide they're shown (tawd_srcsets), and load when
 * scrolled to after the first one. jQuery (which Gravity Forms needs) and Gravity Forms' own scripts go at the end of the
 * page, so the page shows first. Contact Form 7's files load only on a page with a form.
 */
add_filter('render_block_core/image', function ($html) {
	static $count = 0;
	$count++;
	$tags = new WP_HTML_Tag_Processor($html);
	if (!$tags->next_tag('img')) {
		return $html;
	}
	if ($count > 1 && null === $tags->get_attribute('loading')) {
		$tags->set_attribute('loading', 'lazy');
		$tags->set_attribute('decoding', 'async');
	}
	$sets = get_option('tawd_srcsets');
	$src = (string) $tags->get_attribute('src');
	if (is_array($sets) && isset($sets[$src]) && null === $tags->get_attribute('srcset') && count($sets[$src]['set']) > 1) {
		$tags->set_attribute('srcset', implode(', ', array_map(function ($s) {
			return $s['url'] . ' ' . (int) $s['w'] . 'w';
		}, $sets[$src]['set'])));
		$tags->set_attribute('sizes', '(max-width: 600px) ' . (int) $sets[$src]['pw'] . 'px, ' . (int) $sets[$src]['dw'] . 'px');
	}
	return $tags->get_updated_html();
});
add_filter('gform_init_scripts_footer', '__return_true');
add_action('wp_enqueue_scripts', function () {
	$scripts = wp_scripts();
	foreach (array('jquery', 'jquery-core', 'jquery-migrate') as $handle) {
		$scripts->add_data($handle, 'group', 1);
	}
	if (isset($scripts->registered['jquery'])) {
		$scripts->registered['jquery']->deps = array_values(array_diff($scripts->registered['jquery']->deps, array('jquery-migrate')));
	}
}, 1);
function tawd_page_has_form() {
	$post = get_queried_object();
	return TAWD_FORM_IN_PARTS || ($post instanceof WP_Post && (has_shortcode($post->post_content, 'contact-form-7') || has_shortcode($post->post_content, 'gravityform')));
}
add_filter('wpcf7_load_js', 'tawd_page_has_form');
add_filter('wpcf7_load_css', 'tawd_page_has_form');
add_action('wp_footer', function () {
	if (!function_exists('wpcf7')) {
		return;
	}
	echo '<script>document.addEventListener("wpcf7mailsent",function(){window.location.href=' . wp_json_encode(home_url('/thank-you/')) . ';});</script>' . "\n";
});

/*
 * The login name stays private (13 October 2026): each site has its own, and WordPress would otherwise publish it through its
 * users API, author pages (?author=1), the users sitemap and oEmbed. Signed-in people still see everything in wp-admin.
 */
add_filter('rest_endpoints', function ($endpoints) {
	if (is_user_logged_in()) {
		return $endpoints;
	}
	foreach (array_keys($endpoints) as $route) {
		if (strpos($route, '/wp/v2/users') === 0) {
			unset($endpoints[$route]);
		}
	}
	return $endpoints;
});
add_action('template_redirect', function () {
	if (is_author() || (isset($_GET['author']) && !is_user_logged_in())) {
		wp_safe_redirect(home_url('/'), 301);
		exit;
	}
});
add_filter('wp_sitemaps_add_provider', function ($provider, $name) {
	return $name === 'users' ? false : $provider;
}, 10, 2);
add_filter('oembed_response_data', function ($data) {
	unset($data['author_name'], $data['author_url']);
	return $data;
});
`;

/*
  The theme's files, by path inside the theme folder. The same input
  always gives the same files.
*/
export function wordpressTheme(input: WordPressThemeInput): Record<string, string> {
  const slug = themeSlug(input.clientName);
  const version = `1.${input.buildVersion}`;
  const name = commentSafe(input.clientName);
  // A stylesheet's @import lines only count before every other rule, so Build A's (its fonts) go first.
  // Quoted addresses may hold ";" (Google Fonts' "wght@400;700"), so the whole quoted part is read first.
  const imports = input.siteCss.match(/@import\s+(?:url\(\s*)?(?:"[^"]*"|'[^']*'|[^\s;)]+)\s*\)?[^;]*;/g) ?? [];
  const siteCss = imports.reduce((css, line) => css.replace(line, ""), input.siteCss);
  const styleCss = `/*
Theme Name: ${name}
Theme URI: https://velocitymedialab.com
Author: Velocity Media Lab
Description: ${name}'s site, built by TAWD from the approved design (Build A version ${input.buildVersion}).
Version: ${version}
Requires at least: ${WP_THEME_REQUIRES}
Requires PHP: ${WP_THEME_REQUIRES_PHP}
License: Proprietary
Text Domain: ${slug}
*/
${imports.length ? `\n${imports.join("\n")}\n` : ""}
/* WordPress's own spacing between blocks is off (theme.json): the site's stylesheet below sets it, as on Build A. */
.tawd-honeypot { display: none; }
/* Contact Form 7's own extras take no room, so the form sits as on Build A. */
.wpcf7 .hidden-fields-container { display: none; }
.wpcf7 .wpcf7-spinner { position: absolute; }
.wpcf7 form.init .wpcf7-response-output { display: none; }

/* ---------- The site's stylesheet (Build A) ---------- */
${siteCss.trim()}
`;

  const fonts = fontHrefs(input.fontLinks);
  const handle = (i: number) => phpString(`${slug}-font-${i + 1}`);
  const functionsPhp = `<?php
/**
 * ${name}: the theme's styles and fonts. Made by TAWD; edit the design in TAWD, not here.
 */

if (!defined('ABSPATH')) {
\texit;
}

add_action('wp_enqueue_scripts', function () {
${fonts.map((href, i) => `\twp_enqueue_style(${handle(i)}, ${phpString(href)}, array(), null);`).join("\n")}
\twp_enqueue_style(${phpString(`${slug}-style`)}, get_stylesheet_uri(), array(), ${phpString(version)});
});

add_action('after_setup_theme', function () {
\tadd_theme_support('editor-styles');
\tadd_editor_style('style.css');
});

// Whether the header or footer has a form (Contact Form 7's files then load on every page).
define('TAWD_FORM_IN_PARTS', ${/\[(?:contact-form-7|gravityform) /.test(input.parts.header + input.parts.footer) ? "true" : "false"});

// No emoji script: the site doesn't use it.
remove_action('wp_head', 'print_emoji_detection_script', 7);
remove_action('wp_print_styles', 'print_emoji_styles');
${THEME_HOOKS}`;

  return {
    "style.css": styleCss,
    "theme.json": `${JSON.stringify(themeJson(input.design), null, "\t")}\n`,
    "functions.php": functionsPhp,
    "templates/index.html": TEMPLATE,
    "templates/page.html": TEMPLATE,
    "templates/front-page.html": TEMPLATE,
    ...(input.notFound ? { "templates/404.html": template(`\n${input.notFound.trim()}\n`) } : {}),
    "parts/header.html": `${input.parts.header.trim()}\n`,
    "parts/footer.html": `${input.parts.footer.trim()}\n`,
    ...(input.headExtras?.trim() ? { "inc/head.html": `${input.headExtras.trim()}\n` } : {}),
    ...(input.bodyEnd?.trim() ? { "inc/body-end.html": `${input.bodyEnd.trim()}\n` } : {}),
  };
}
