/*
  Build B, B1 (1 October 2026): install.php, the package's installer. It
  runs inside the client's WordPress (wp eval-file install.php) and reads
  only the package's own files: manifest.json, the theme, the pages and the
  media. Nothing in it comes from a client: the client's words reach
  WordPress only as page content and settings, through WordPress's own
  functions, never as PHP. The same file for every client.

  Safe to run again: it finds what it made before (pages by their Build A
  path, pictures by their file, forms by their name) and updates them.
  What the team changed in WordPress (the header, footer and templates in
  the Site Editor, the Main menu) is theirs and kept, unless it's run with
  "reset" (Jason, 1 October 2026). A WordPress in a folder
  (localhost/sample/) gets its links and address rules fixed for the folder.
*/
export const WP_INSTALL_PHP = String.raw`<?php
/**
 * TAWD's WordPress installer (Build B). Made by TAWD; the same file for every client.
 *
 * Run it inside the WordPress site, from the package's folder:
 *   wp eval-file install.php
 * Safe to run again: it updates what it made before and leaves everything else alone.
 * The team's changes in WordPress (header, footer, templates, the Main menu) are kept; to replace them with TAWD's:
 *   wp eval-file install.php reset
 */

if (!defined('ABSPATH')) {
	fwrite(STDERR, "Run this inside WordPress: wp eval-file install.php\n");
	exit(1);
}

require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/theme.php';

function tawd_say($text) {
	if (defined('WP_CLI') && WP_CLI) {
		WP_CLI::log($text);
	} else {
		echo $text, "\n";
	}
}

function tawd_fail($text) {
	if (defined('WP_CLI') && WP_CLI) {
		WP_CLI::error($text);
	}
	throw new RuntimeException($text);
}

function tawd_copy_dir($from, $to) {
	if (!is_dir($to) && !wp_mkdir_p($to)) {
		tawd_fail('Could not make the folder ' . $to);
	}
	foreach (scandir($from) as $item) {
		if ($item === '.' || $item === '..') {
			continue;
		}
		$src = $from . '/' . $item;
		$dst = $to . '/' . $item;
		if (is_dir($src)) {
			tawd_copy_dir($src, $dst);
		} elseif (!copy($src, $dst)) {
			tawd_fail('Could not copy ' . $src);
		}
	}
}

function tawd_remove_dir($dir) {
	foreach (scandir($dir) as $item) {
		if ($item === '.' || $item === '..') {
			continue;
		}
		$path = $dir . '/' . $item;
		if (is_dir($path) && !is_link($path)) {
			tawd_remove_dir($path);
		} else {
			unlink($path);
		}
	}
	rmdir($dir);
}

/* Build A's addresses for its files ("/images/hero.jpg") become the files' addresses on this site. */
function tawd_urls($text, $urls) {
	if (!$urls) {
		return $text;
	}
	$paths = array_keys($urls);
	usort($paths, function ($a, $b) {
		return strlen($b) - strlen($a);
	});
	$pattern = '~(?<=["\'(\s,=])(' . implode('|', array_map(function ($p) {
		return preg_quote($p, '~');
	}, $paths)) . ')(?=["\')\s,?#]|$)~';
	return preg_replace_callback($pattern, function ($m) use ($urls) {
		return $urls[$m[1]];
	}, $text);
}

/* In a WordPress in a folder (localhost/sample/), Build A's links ("/about/") get the folder in front. */
function tawd_links($text, $base) {
	if ($base === '') {
		return $text;
	}
	return preg_replace_callback('~(\s(?:href|src|action)\s*=\s*["\'])/(?!/)~i', function ($m) use ($base) {
		return $m[1] . $base . '/';
	}, $text);
}

function tawd_find($type, $key, $value, $status = 'any') {
	$found = get_posts(array(
		'post_type' => $type,
		'post_status' => $status,
		'meta_key' => $key,
		'meta_value' => $value,
		'fields' => 'ids',
		'numberposts' => 1,
	));
	return $found ? (int) $found[0] : 0;
}

$tawd_dir = defined('TAWD_PACKAGE_DIR') ? TAWD_PACKAGE_DIR : __DIR__;
$manifest = json_decode((string) @file_get_contents($tawd_dir . '/manifest.json'), true);
if (!is_array($manifest) || ($manifest['tawd'] ?? 0) !== 1) {
	tawd_fail('manifest.json is missing, or not a TAWD package.');
}
$slug = (string) $manifest['theme'];
if (!preg_match('/^tawd-[a-z0-9-]+$/', $slug)) {
	tawd_fail('The theme name is not one TAWD makes.');
}

// "reset": the team's changes in WordPress go and TAWD's come back.
$reset = in_array('reset', isset($args) ? (array) $args : array(), true) || (defined('TAWD_RESET') && TAWD_RESET);
// The folder WordPress is in, for its links ('' at the top of the domain, '/sample' in localhost/sample/).
$base = rtrim((string) wp_parse_url(home_url('/'), PHP_URL_PATH), '/');

// The content is TAWD's own markup (styles, SVGs, scripts as on Build A); WordPress's filter for untrusted posts would strip it.
kses_remove_filters();

/* 1. The pictures and files, at /wp-content/uploads/tawd/, the pictures also in the Media Library. */
$uploads = wp_upload_dir();
$base_dir = $uploads['basedir'] . '/tawd';
$base_url = $uploads['baseurl'] . '/tawd';
$urls = array();
// One file each: the site uses the pictures at their own size.
add_filter('intermediate_image_sizes_advanced', '__return_empty_array');
foreach ($manifest['media'] as $path) {
	if (strpos($path, '..') !== false || !preg_match('~^[\w .,()@+-]+(/[\w .,()@+-]+)*$~u', $path)) {
		tawd_say('Skipped a file with an unusual name: ' . $path);
		continue;
	}
	$src = $tawd_dir . '/media/' . $path;
	$dst = $base_dir . '/' . $path;
	wp_mkdir_p(dirname($dst));
	if (!copy($src, $dst)) {
		tawd_fail('Could not copy ' . $path);
	}
	$urls['/' . $path] = $base_url . '/' . $path;
	$type = wp_check_filetype($dst);
	if (strpos((string) $type['type'], 'image/') === 0 && $type['type'] !== 'image/svg+xml' && !tawd_find('attachment', '_tawd_source', $path, 'inherit')) {
		$id = wp_insert_attachment(array(
			'post_mime_type' => $type['type'],
			'post_title' => sanitize_text_field(pathinfo($path, PATHINFO_FILENAME)),
			'post_status' => 'inherit',
		), $dst);
		if ($id && !is_wp_error($id)) {
			update_post_meta($id, '_tawd_source', $path);
			wp_update_attachment_metadata($id, wp_generate_attachment_metadata($id, $dst));
		}
	}
}
tawd_say('Files: ' . count($urls));

/* 2. The theme, with the files' addresses, switched on. What the team changed in the Site Editor is kept (WordPress shows their copy), unless reset. */
$theme_dir = get_theme_root() . '/' . $slug;
// The theme's folder is TAWD's own (tawd-...): last time's files go, so nothing stale stays.
if (is_dir($theme_dir)) {
	tawd_remove_dir($theme_dir);
}
tawd_copy_dir($tawd_dir . '/theme/' . $slug, $theme_dir);
foreach (array_merge(glob($theme_dir . '/parts/*.html') ?: array(), glob($theme_dir . '/templates/*.html') ?: array(), glob($theme_dir . '/inc/*.html') ?: array(), array($theme_dir . '/style.css')) as $file) {
	file_put_contents($file, tawd_links(tawd_urls((string) file_get_contents($file), $urls), $base));
}
$edited = get_posts(array(
	'post_type' => array('wp_template', 'wp_template_part'),
	'post_status' => 'any',
	'numberposts' => -1,
	'fields' => 'ids',
	'tax_query' => array(array('taxonomy' => 'wp_theme', 'field' => 'name', 'terms' => $slug)),
));
if ($reset) {
	foreach ($edited as $id) {
		wp_delete_post($id, true);
	}
	if ($edited) {
		tawd_say('Reset: the header, footer and templates are TAWD\'s again');
	}
} elseif ($edited) {
	tawd_say('Kept (edited in WordPress): ' . implode(', ', array_map(function ($id) {
		return get_post_field('post_name', $id);
	}, $edited)) . '. Run with reset to replace them with TAWD\'s.');
}
// Only when it isn't on yet: switching again makes WordPress put back the menu places from before (a reset's old, deleted menu).
if (get_stylesheet() !== $slug) {
	switch_theme($slug);
}
tawd_say('Theme: ' . $slug);

/* 3. The forms: each sends to the client, with a copy to VML. In Contact Form 7 (the default) or Gravity Forms (the project's choice). */
$form_ids = array();
$form_plugin = (string) ($manifest['formPlugin'] ?? 'cf7');
$host = (string) wp_parse_url(home_url(), PHP_URL_HOST);
$to = array_values(array_filter((array) ($manifest['formEmails']['to'] ?? array()), 'is_email'));
$copy = (string) ($manifest['formEmails']['copy'] ?? '');
if (!$to) {
	$to = $copy !== '' ? array($copy) : array(get_option('admin_email'));
}
if ($form_plugin === 'cf7' && class_exists('WPCF7_ContactForm')) {
	foreach ($manifest['forms'] as $f) {
		$title = 'TAWD: ' . $f['name'];
		$found = WPCF7_ContactForm::find(array('title' => $title, 'post_status' => 'any'));
		$form = $found ? $found[0] : WPCF7_ContactForm::get_template(array('title' => $title));
		$headers = array();
		if (!empty($f['replyTo'])) {
			$headers[] = 'Reply-To: [' . $f['replyTo'] . ']';
		}
		if ($copy !== '' && is_email($copy) && !in_array($copy, $to, true)) {
			$headers[] = 'Bcc: ' . $copy;
		}
		$form->set_title($title);
		$form->set_properties(array(
			'form' => tawd_links(tawd_urls($f['template'], $urls), $base),
			'mail' => array(
				'active' => true,
				'subject' => $f['subject'],
				'sender' => $manifest['client'] . ' <wordpress@' . $host . '>',
				'recipient' => implode(', ', $to),
				'body' => $f['mailBody'],
				'additional_headers' => implode("\n", $headers),
				'attachments' => (string) ($f['attachments'] ?? ''),
				'use_html' => false,
				'exclude_blank' => false,
			),
		));
		$form->save();
		$form_ids[$f['name']] = $form->id();
	}
	tawd_say('Forms: ' . count($form_ids));
} elseif ($form_plugin === 'gravityforms' && class_exists('GFAPI')) {
	// Gravity Forms: one form per Build A form, its fields from the same reading; the messages are also kept in WordPress (Entries).
	$types = array('text' => 'text', 'tel' => 'phone', 'email' => 'email', 'textarea' => 'textarea', 'select' => 'select', 'file' => 'fileupload', 'checkbox' => 'consent', 'number' => 'number', 'url' => 'website', 'date' => 'date');
	$looks = array();
	$existing = array();
	foreach (GFAPI::get_forms(null, false) as $g) {
		$existing[$g['title']] = (int) $g['id'];
	}
	foreach ($manifest['forms'] as $f) {
		$title = 'TAWD: ' . $f['name'];
		$look = (array) ($f['look'] ?? array());
		$fields = array();
		$email_tag = '';
		foreach ($f['fields'] as $i => $field) {
			$id = $i + 1;
			$type = $types[$field['type']] ?? 'text';
			$gf = array('id' => $id, 'type' => $type, 'label' => $field['label'], 'isRequired' => !empty($field['required']), 'inputName' => $field['name'], 'cssClass' => (string) ($look['wrapper'] ?? ''));
			if ($type === 'phone') {
				$gf['phoneFormat'] = 'standard';
			}
			if ($type === 'select') {
				$gf['choices'] = array_map(function ($o) {
					return array('text' => $o, 'value' => $o);
				}, (array) ($field['options'] ?? array()));
				$gf['placeholder'] = 'Choose one';
			}
			if ($type === 'fileupload') {
				$gf['allowedExtensions'] = 'jpg,jpeg,png,gif,webp,heic';
				$gf['maxFileSize'] = 8;
			}
			if ($type === 'consent') {
				$gf['checkboxLabel'] = $field['label'];
			}
			if ($type === 'email' && $email_tag === '') {
				$email_tag = '{' . $field['label'] . ':' . $id . '}';
			}
			$fields[] = $gf;
		}
		$form = array(
			'title' => $title,
			'description' => '',
			'labelPlacement' => 'top_label',
			'cssClass' => (string) ($f['htmlClass'] ?? ''),
			'button' => array('type' => 'text', 'text' => (string) ($look['buttonText'] ?? 'Send message')),
			'fields' => $fields,
			'notifications' => array(
				'tawd' => array(
					'id' => 'tawd',
					'name' => 'TAWD: to the client',
					'isActive' => true,
					'event' => 'form_submission',
					'toType' => 'email',
					'to' => implode(',', $to),
					'bcc' => ($copy !== '' && is_email($copy) && !in_array($copy, $to, true)) ? $copy : '',
					'subject' => $f['subject'],
					'message' => '{all_fields}',
					'from' => 'wordpress@' . $host,
					'fromName' => $manifest['client'],
					'replyTo' => $email_tag,
				),
			),
			'confirmations' => array(
				'tawd' => array('id' => 'tawd', 'name' => 'TAWD: thank-you page', 'isDefault' => true, 'type' => 'redirect', 'url' => home_url('/thank-you/')),
			),
		);
		if (isset($existing[$title])) {
			$form['id'] = $existing[$title];
			// The team's own notifications, confirmations and fields stay; TAWD's ("tawd", its own field numbers) are replaced (3 October 2026).
			$old = GFAPI::get_form($existing[$title]);
			if (is_array($old)) {
				foreach ((array) ($old['notifications'] ?? array()) as $key => $n) {
					if ($key !== 'tawd' && !isset($form['notifications'][$key])) {
						$form['notifications'][$key] = $n;
					}
				}
				foreach ((array) ($old['confirmations'] ?? array()) as $key => $c) {
					if ($key !== 'tawd' && !isset($form['confirmations'][$key])) {
						$c['isDefault'] = false;
						$form['confirmations'][$key] = $c;
					}
				}
				$ours = array_map(function ($x) {
					return (int) $x['id'];
				}, $form['fields']);
				foreach ((array) ($old['fields'] ?? array()) as $x) {
					$xid = (int) (is_object($x) ? $x->id : ($x['id'] ?? 0));
					if ($xid && $xid > count($ours) && !in_array($xid, $ours, true)) {
						$form['fields'][] = $x;
					}
				}
			}
			$saved = GFAPI::update_form($form);
			$fid = $existing[$title];
		} else {
			$saved = GFAPI::add_form($form);
			$fid = $saved;
		}
		if (is_wp_error($saved)) {
			tawd_fail('Gravity Forms didn\'t save the form ' . $f['name'] . ': ' . $saved->get_error_message());
		}
		$form_ids[$f['name']] = (int) $fid;
		$looks[(int) $fid] = $look;
	}
	// The theme dresses Gravity Forms' fields and button in Build A's own classes.
	update_option('tawd_form_looks', $looks, false);
	tawd_say('Forms (Gravity Forms): ' . count($form_ids));
} elseif ($manifest['forms']) {
	tawd_say(($form_plugin === 'gravityforms' ? 'Gravity Forms' : 'Contact Form 7') . ' is not active, so the forms are not made yet: activate it and run this again.');
}

/* 4. The pages, parents first. */
$pages = $manifest['pages'];
usort($pages, function ($a, $b) {
	return substr_count($a['path'], '/') - substr_count($b['path'], '/');
});
$ids = array();
foreach ($pages as $p) {
	$content = tawd_links(tawd_urls((string) file_get_contents($tawd_dir . '/' . $p['file']), $urls), $base);
	foreach ($form_ids as $name => $form_id) {
		$content = str_replace('id="tawd-form:' . $name . '"', 'id="' . $form_id . '"', $content);
	}
	$postarr = array(
		'post_type' => 'page',
		'post_status' => 'publish',
		'post_title' => $p['title'],
		'post_name' => $p['slug'],
		'post_parent' => $p['parent'] ? ($ids[$p['parent']] ?? 0) : 0,
		'menu_order' => (int) $p['order'],
		'post_content' => $content,
		'comment_status' => 'closed',
		'ping_status' => 'closed',
	);
	$existing = tawd_find('page', '_tawd_path', $p['path']);
	if ($existing) {
		$postarr['ID'] = $existing;
	}
	$id = wp_insert_post(wp_slash($postarr), true);
	if (is_wp_error($id)) {
		tawd_fail('Could not save the page ' . $p['path'] . ': ' . $id->get_error_message());
	}
	$ids[$p['path']] = $id;
	$meta = array(
		'_tawd_path' => $p['path'],
		'_tawd_main_class' => $p['mainClass'],
		'_tawd_schema' => $p['schema'],
		'rank_math_title' => $p['seoTitle'],
		'rank_math_description' => $p['description'],
		'rank_math_focus_keyword' => $p['focusKeyword'],
	);
	foreach ($meta as $key => $value) {
		if ((string) $value === '') {
			delete_post_meta($id, $key);
		} else {
			update_post_meta($id, $key, wp_slash($value));
		}
	}
	tawd_say('Page: ' . $p['path']);
}

/* 4b. The header's menu: "Main menu", made once from Build A's; after that it's the team's (Appearance, Menus), unless reset. */
$menu = $manifest['menu'] ?? null;
if (is_array($menu) && !empty($menu['navs'])) {
	$looks = array('_items' => $menu['items']);
	foreach ($menu['navs'] as $n) {
		$looks[$n['key']] = array('template' => $n['template'], 'gap' => $n['gap']);
	}
	update_option('tawd_menus', $looks, false);
	$menu_id = (int) get_option('tawd_menu_id');
	$made = $menu_id && wp_get_nav_menu_object($menu_id);
	if ($made && $reset) {
		wp_delete_nav_menu($menu_id);
		$made = false;
	}
	if ($made) {
		tawd_say('Menu: kept (edited in WordPress, Appearance, Menus)');
	} else {
		$named = wp_get_nav_menu_object('Main menu');
		if ($named && $reset) {
			wp_delete_nav_menu($named->term_id);
			$named = false;
		}
		$menu_id = $named ? (int) $named->term_id : wp_create_nav_menu('Main menu');
		if (is_wp_error($menu_id)) {
			tawd_fail('Could not make the menu: ' . $menu_id->get_error_message());
		}
		if (!$named) {
			foreach ($menu['items'] as $i => $item) {
				$page = $ids[$item['path']] ?? 0;
				wp_update_nav_menu_item($menu_id, 0, $page ? array(
					'menu-item-title' => $item['label'],
					'menu-item-object' => 'page',
					'menu-item-object-id' => $page,
					'menu-item-type' => 'post_type',
					'menu-item-status' => 'publish',
					'menu-item-position' => $i + 1,
				) : array(
					'menu-item-title' => $item['label'],
					'menu-item-url' => home_url($item['path']),
					'menu-item-type' => 'custom',
					'menu-item-status' => 'publish',
					'menu-item-position' => $i + 1,
				));
			}
		}
		update_option('tawd_menu_id', (int) $menu_id, false);
		tawd_say($named ? 'Menu: kept (Main menu, edited in WordPress)' : 'Menu: ' . count($menu['items']) . ' items');
	}
	// The header's menu place keeps a menu the team chose there; TAWD's goes in when it's empty, on reset, or its menu is gone (3 October 2026).
	$locations = get_theme_mod('nav_menu_locations');
	$locations = is_array($locations) ? $locations : array();
	$current = (int) ($locations['primary'] ?? 0);
	if ($reset || !$current || !wp_get_nav_menu_object($current)) {
		$locations['primary'] = (int) $menu_id;
		set_theme_mod('nav_menu_locations', $locations);
	} elseif ($current !== (int) $menu_id) {
		tawd_say('Menu place: kept the menu the team chose for the header');
	}
	// Just switched to the theme: WordPress maps the old theme's menu places on the next page load, so it gets this one.
	if (get_option('theme_switch_menu_locations', false) !== false) {
		update_option('theme_switch_menu_locations', $locations);
	}
}

/* 5. The site's settings: the home page, Build A's addresses, the name, hidden from search engines until go-live. */
if (isset($ids['/'])) {
	update_option('show_on_front', 'page');
	update_option('page_on_front', $ids['/']);
}
if (isset($ids['/privacy/'])) {
	update_option('wp_page_for_privacy_policy', $ids['/privacy/']);
}
update_option('blogname', $manifest['client']);
update_option('blogdescription', '');
update_option('blog_public', $manifest['mode'] === 'live' ? 1 : 0);
// Rank Math writes the titles and descriptions only once its account step is done or skipped (it never was from the command line,
// so the pages had no description): skipped, as its own setup lets you.
update_option('rank_math_registration_skip', 1);
update_option('rank_math_wizard_completed', true);
update_option('rank_math_is_configured', true);
// The speed pass's picture sizes, at their addresses on this site, for picture blocks (the theme adds srcset).
$srcsets = array();
foreach ((array) ($manifest['srcsets'] ?? array()) as $main => $info) {
	$set = array();
	foreach ((array) ($info['set'] ?? array()) as $size) {
		$set[] = array('w' => (int) $size['w'], 'url' => $urls[$size['url']] ?? $size['url']);
	}
	$srcsets[$urls[$main] ?? $main] = array('set' => $set, 'dw' => (int) ($info['dw'] ?? 0), 'pw' => (int) ($info['pw'] ?? 0));
}
update_option('tawd_srcsets', $srcsets, false);
global $wp_rewrite;
$wp_rewrite->set_permalink_structure('/%postname%/');
// WordPress's sample post and page, on a new site only.
foreach (array(array('hello-world', 'post'), array('sample-page', 'page')) as $sample) {
	$post = get_page_by_path($sample[0], OBJECT, $sample[1]);
	if ($post && !get_post_meta($post->ID, '_tawd_path', true)) {
		wp_delete_post($post->ID, true);
	}
}

/*
 * 5b. Speed: browsers keep the pictures and fonts (their names change when they do: a year), the styles and scripts a month
 * (WordPress adds their version), and pages and files go compressed.
 */
insert_with_markers(get_home_path() . '.htaccess', 'TAWD speed', array(
	'<IfModule mod_deflate.c>',
	'AddOutputFilterByType DEFLATE text/html text/css text/plain text/xml application/javascript application/json image/svg+xml',
	'</IfModule>',
	'<IfModule mod_expires.c>',
	'ExpiresActive On',
	'ExpiresByType text/css "access plus 1 month"',
	'ExpiresByType application/javascript "access plus 1 month"',
	'ExpiresByType image/webp "access plus 1 month"',
	'ExpiresByType image/jpeg "access plus 1 month"',
	'ExpiresByType image/png "access plus 1 month"',
	'ExpiresByType image/svg+xml "access plus 1 month"',
	'ExpiresByType font/woff2 "access plus 1 year"',
	'</IfModule>',
));
if (is_dir($base_dir . '/assets')) {
	insert_with_markers($base_dir . '/assets/.htaccess', 'TAWD speed', array(
		'<IfModule mod_headers.c>',
		'Header set Cache-Control "public, max-age=31536000, immutable"',
		'</IfModule>',
		'<IfModule mod_expires.c>',
		'ExpiresActive On',
		'ExpiresDefault "access plus 1 year"',
		'</IfModule>',
	));
}

/* 6. The client's old addresses go to their new pages (301), as on Build A. */
$lines = array();
foreach ($manifest['redirects'] as $r) {
	if ($r['from'] !== '/' && preg_match('~^/[^\s"\\\\?]*$~', $r['from']) && preg_match('~^(/|https?://)[^\s"\\\\]*$~', $r['to'])) {
		$from = '^' . preg_quote($base . rtrim($r['from'], '/'), '"') . '/?$';
		$lines[] = 'RedirectMatch ' . (int) $r['code'] . ' "' . $from . '" "' . ($r['to'][0] === '/' ? $base : '') . $r['to'] . '"';
	} else {
		tawd_say('Skipped a redirect with an unusual address: ' . $r['from']);
	}
}
flush_rewrite_rules(true);
// WordPress's own address rules ("/about/" to index.php). From the command line WordPress doesn't write them
// itself (it can't tell Apache has mod_rewrite), so without these only the home page opens (the first trial).
insert_with_markers(get_home_path() . '.htaccess', 'WordPress', array(
	'<IfModule mod_rewrite.c>',
	'RewriteEngine On',
	'RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]',
	'RewriteBase ' . $base . '/',
	'RewriteRule ^index\.php$ - [L]',
	'RewriteCond %{REQUEST_FILENAME} !-f',
	'RewriteCond %{REQUEST_FILENAME} !-d',
	'RewriteRule . ' . $base . '/index.php [L]',
	'</IfModule>',
));
if ($lines) {
	insert_with_markers(get_home_path() . '.htaccess', 'TAWD redirects', $lines);
}
tawd_say('Redirects: ' . count($lines));

tawd_say('Done: ' . count($ids) . ' pages at ' . home_url('/'));
`;
