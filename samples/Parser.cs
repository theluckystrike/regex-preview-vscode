using System.Text.RegularExpressions;

namespace Example.Text;

public static class Parser
{
    private static readonly Regex Guid = new Regex(@"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", RegexOptions.IgnoreCase);
    private static readonly Regex Quoted = new Regex(@"""(?<text>(?:[^""\\]|\\.)*)""");

    public static bool HasCurrency(string s) => Regex.IsMatch(s, @"(?<![\w.])\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?(?:USD|EUR|THB)\b");
}
