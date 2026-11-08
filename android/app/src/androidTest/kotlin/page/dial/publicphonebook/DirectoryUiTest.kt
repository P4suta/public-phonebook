package page.dial.publicphonebook

import android.graphics.Bitmap
import android.os.Build
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Rule
import org.junit.Test

class DirectoryUiTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun searchDetailsAndExternalConfirmationRemainAccessible() {
        rule.waitUntil(PREPARATION_TIMEOUT_MILLIS) {
            rule.onAllNodesWithText("施設名・地域・電話番号").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("施設名・地域・電話番号").performTextInput("図書館")
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) { imeVisible() }
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) {
            rule.onAllNodes(resultButton).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("施設名・地域・電話番号").performImeAction()
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) { !imeVisible() }
        rule.onNodeWithText("Public Phonebook").assertIsDisplayed()
        capture("search")
        expandLibrary()
        rule.onAllNodes(resultButton).onFirst().performClick()
        rule.onNodeWithText("電話番号を開く").assertHeightIsAtLeast(48.dp).performClick()
        rule.onNodeWithText("キャンセル").assertIsDisplayed().performClick()
        rule.onNodeWithText("地図を開く").performScrollTo().performClick()
        rule.onNodeWithText("キャンセル").performClick()
        capture("details")
        rule.onNodeWithText("戻る").performClick()
        rule.onNodeWithText("着信とデータ更新").performClick()
        rule.onNodeWithText("着信時の施設名表示").assertIsDisplayed()
        capture("settings")
        rule.onNodeWithText("戻る").performClick()
        rule.onNodeWithText("アプリ情報").performClick()
        capture("about")
        rule.onNodeWithText("オープンソースの利用条件").performScrollTo().performClick()
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) {
            rule
                .onAllNodesWithText("Apache License", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
    }

    private fun expandLibrary() {
        val list = rule.onNode(hasScrollToIndexAction())
        list.performScrollToNode(hasText("図書館の続きを表示"))
        rule.onNodeWithText("図書館の続きを表示").assertHeightIsAtLeast(48.dp).performClick()
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) {
            rule.onAllNodesWithText("続きを読み込んでいます").fetchSemanticsNodes().isEmpty()
        }
        rule.onAllNodesWithText("続きを読み込めませんでした。").assertCountEquals(0)
        capture("search-expanded")
        list.performScrollToIndex(0)
    }

    private fun imeVisible(): Boolean = rule.runOnIdle {
        ViewCompat.getRootWindowInsets(rule.activity.window.decorView)
            ?.isVisible(WindowInsetsCompat.Type.ime()) == true
    }

    private fun capture(name: String) {
        rule.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(
            ACCESSIBILITY_IDLE_MILLIS,
            SCREENSHOT_TIMEOUT_MILLIS,
        )
        val image = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        val directory =
            File(instrumentation.targetContext.getExternalFilesDir(null), "screenshots").apply {
                mkdirs()
            }
        File(directory, "api${Build.VERSION.SDK_INT}-$name.png").outputStream().use {
            check(image.compress(Bitmap.CompressFormat.PNG, PNG_QUALITY, it))
        }
        image.recycle()
    }

    companion object {
        private val resultButton =
            hasClickAction() and
                hasText("図書館", substring = true) and
                !hasText("続きを", substring = true) and
                SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button)
        private const val PREPARATION_TIMEOUT_MILLIS = 180_000L
        private const val SEARCH_TIMEOUT_MILLIS = 30_000L
        private const val PNG_QUALITY = 100
        private const val ACCESSIBILITY_IDLE_MILLIS = 500L
        private const val SCREENSHOT_TIMEOUT_MILLIS = 5000L
    }
}
