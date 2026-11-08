package com.example.validation;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class Validator {
    private static final Pattern PHONE = Pattern.compile("^\\+?(\\d{1,3})?[-. ]?\\(?(\\d{3})\\)?[-. ]?(\\d{3})[-. ]?(\\d{4})$");
    private static final Pattern TAG = Pattern.compile("<(?<tag>[a-z][a-z0-9]*)\\b[^>]*>(.*?)</\\k<tag>>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    public static boolean isPhone(String s) {
        return PHONE.matcher(s).matches();
    }

    public static String squash(String s) {
        return s.replaceAll("\\s{2,}", " ");
    }
}
