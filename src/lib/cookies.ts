type CookiesApi = {
  cookies: {
    get(details: { url: string; name: string }): Promise<{ name: string; value: string } | null>;
  };
};

export type CsrfRecipe = {
  targetOrigin: string;
  csrfRule: { header: string; cookie: string };
};

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

export async function buildCsrfHeaders(
  recipe: CsrfRecipe,
): Promise<Record<string, string> | null> {
  const chrome = (globalThis as unknown as { chrome: CookiesApi }).chrome;
  const cookie = await chrome.cookies.get({
    url: recipe.targetOrigin,
    name: recipe.csrfRule.cookie,
  });

  if (!cookie || typeof cookie.value !== "string" || cookie.value.trim() === "") {
    return null;
  }

  return { [recipe.csrfRule.header]: stripWrappingQuotes(cookie.value) };
}
