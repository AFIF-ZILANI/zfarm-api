/**
 * Derives a stable lookup-table `code` from a user-entered `label`. Order
 * matters: stripping special characters before collapsing whitespace avoids
 * a double-underscore artifact when punctuation sits next to a space
 * ("Feed - Type" -> "FEED_TYPE", not "FEED__TYPE"). Called on every
 * create/update in lookup-factory.ts -- code is never client-supplied.
 */
export function generateCode(label: string): string {
    const trimmed = label.trim().toUpperCase();
    const withoutSpecial = trimmed.replace(/[^A-Z0-9\s]/g, "");
    // If there are no alphanumeric characters, return empty string
    if (!/[A-Z0-9]/.test(withoutSpecial)) {
        return "";
    }
    return withoutSpecial.replace(/\s+/g, "_");
}

/**
 * Units are named in any script and often carry a size ("Bag 12.5kg", "ছোট বস্তা"), so letters, vowel signs
 * and digits of every script stay, and so does a decimal point between digits: "Bag 12.5kg" must never
 * read as "BAG_125KG". Also the key two names are compared by, so "Small-Bag" is "Small Bag".
 */
export function generateUnitCode(label: string): string {
    const code = label
        .normalize("NFC")
        .replace(/[‌‍]/g, "") // joiners inside Bangla words
        .toUpperCase()
        .replace(/[^\p{L}\p{M}\p{N}.]+/gu, " ")
        .replace(/(?<!\p{N})\.|\.(?!\p{N})/gu, " ")
        .trim()
        .replace(/\s+/g, "_");
    return /[\p{L}\p{N}]/u.test(code) ? code : "";
}
