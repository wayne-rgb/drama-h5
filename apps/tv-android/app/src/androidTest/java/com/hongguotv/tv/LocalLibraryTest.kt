package com.hongguotv.tv

import androidx.test.core.app.ApplicationProvider
import android.content.Context
import org.junit.Assert.*
import org.junit.Test

class LocalLibraryTest {
    @Test fun localRecordsPersistAndRemovedRemoteSettingsArePurged() {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val name="library-test-${System.nanoTime()}.sqlite"
        val library=TvLibrary(context,name)
        library.write("favorite","a","set",Series("a","剧名").toJson())
        assertEquals(1,library.rows("favorite").size)
        library.write("favorite","a","delete",null)
        assertTrue(library.rows("favorite").isEmpty())
        library.write("favorite","a","set",Series("a","重新追剧").toJson())
        assertEquals("重新追剧",library.rows("favorite").first().getJSONObject("value").getString("title"))
        library.setSetting("remoteUrl","https://example.test")
        library.close()
        TvLibrary(context,name).use { reopened ->
            assertEquals("重新追剧",reopened.rows("favorite").first().getJSONObject("value").getString("title"))
            assertEquals("",reopened.setting("remoteUrl"))
        }
    }
}
