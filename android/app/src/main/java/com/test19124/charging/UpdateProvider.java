package com.test19124.charging;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;

/** 只服务 cacheDir 下的 update.apk，供系统安装器读取。 */
public class UpdateProvider extends ContentProvider {

    public static Uri uriFor(android.content.Context ctx, File file) {
        return new Uri.Builder()
                .scheme("content")
                .authority(ctx.getPackageName() + ".updates")
                .appendPath(file.getName())
                .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || !name.startsWith("update") || !name.endsWith(".apk")) {
            throw new java.io.FileNotFoundException("not found");
        }
        File f = new File(getContext().getCacheDir(), name);
        try {
            String base = getContext().getCacheDir().getCanonicalPath();
            if (!f.getCanonicalPath().startsWith(base + java.io.File.separator)) {
                throw new java.io.FileNotFoundException("not found");
            }
        } catch (java.io.IOException e) {
            throw new java.io.FileNotFoundException("not found");
        }
        if (!f.isFile()) {
            throw new java.io.FileNotFoundException("not found");
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
