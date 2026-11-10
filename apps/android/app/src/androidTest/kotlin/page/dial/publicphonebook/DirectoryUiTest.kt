package page.dial.publicphonebook

import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Build
import android.view.inputmethod.EditorInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlin.math.ceil
import org.junit.Rule
import org.junit.Test

class DirectoryUiTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun searchDetailsAndExternalConfirmationRemainAccessible() {
        rule.waitUntil(PREPARATION_TIMEOUT_MILLIS) {
            rule.onAllNodesWithText("検索語").fetchSemanticsNodes().isNotEmpty()
        }
        composeSearch()
        rule.onNodeWithText("検索語").performImeAction()
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) { !imeVisible() }
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) {
            rule.onAllNodes(resultButton).fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("施設を探す").assertIsDisplayed()
        capture("search")
        expandLibrary()
        rule
            .onAllNodes(resultButton)
            .onFirst()
            .assert(buttonRole)
            .assertHeightIsAtLeast(48.dp)
            .performClick()
        selectAction("電話番号を開く")
        capture("call-confirmation")
        rule.onNodeWithText("キャンセル").assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        selectAction("地図を開く")
        capture("map-confirmation")
        rule.onNodeWithText("キャンセル").performClick()
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(0)
        capture("details")
        back()
        rule
            .onNodeWithContentDescription("着信とデータ更新")
            .assertHeightIsAtLeast(48.dp)
            .assertWidthIsAtLeast(48.dp)
            .performClick()
        rule.onNodeWithText("着信時の施設名表示").assertIsDisplayed()
        capture("settings")
        back()
        rule
            .onNodeWithContentDescription("アプリ情報")
            .assertHeightIsAtLeast(48.dp)
            .assertWidthIsAtLeast(48.dp)
            .performClick()
        capture("about")
        selectAction("プログラムと決まりを見る")
        rule
            .onNodeWithText("https://github.com/P4suta/public-phonebook", substring = true)
            .assertIsDisplayed()
        capture("source-code-confirmation")
        rule.onNodeWithText("キャンセル").performClick()
        capture("about-open-source")
        rule.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("ありません。"))
        rule.onNodeWithText("ありません。").assertIsDisplayed()
        selectAction("プライバシーについて読む")
        rule.onNodeWithText("${BuildConfig.ORIGIN}/privacy", substring = true).assertIsDisplayed()
        rule.onNodeWithText("キャンセル").performClick()
        selectAction("オープンソースの利用条件")
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) {
            rule
                .onAllNodesWithText("Apache License", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        back()
        back()
        rule.onNodeWithText("とうきょう としょかん").assertIsDisplayed()
        rule
            .onNodeWithContentDescription("検索語を消去")
            .assertHeightIsAtLeast(48.dp)
            .assertWidthIsAtLeast(48.dp)
            .performClick()
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) {
            rule.onAllNodes(resultButton).fetchSemanticsNodes().isEmpty()
        }
        rule.onNodeWithText("検索のヒント").assertIsDisplayed()
        rule.onNodeWithText("施設の名前を入れてください。").assertIsDisplayed()
        capture("search-empty")
        inspectCallerDisplay()
    }

    private fun inspectCallerDisplay() {
        rule.runOnUiThread {
            rule.activity.startActivity(
                Intent(rule.activity, CallerActivity::class.java)
                    .putExtra("name", "表示確認用の施設")
                    .putExtra("address", "東京都千代田区"),
            )
        }
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) {
            rule.onAllNodesWithText("表示確認用の施設").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithText("閉じる").performScrollTo().assertHeightIsAtLeast(48.dp)
        capture("incoming")
        rule.onNodeWithText("閉じる").performClick()
        rule.onNodeWithText("施設を探す").assertIsDisplayed()
    }

    private fun back() {
        rule
            .onNodeWithContentDescription("戻る")
            .assertHeightIsAtLeast(48.dp)
            .assertWidthIsAtLeast(48.dp)
            .performClick()
    }

    private fun selectAction(label: String) {
        rule.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(label))
        rule.onNodeWithText(label).assert(buttonRole).assertHeightIsAtLeast(48.dp).performClick()
    }

    private fun composeSearch() {
        rule.onNodeWithText("検索語").performClick()
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) { imeVisible() }
        val model = rule.runOnIdle {
            ViewModelProvider(rule.activity)[DirectoryViewModel::class.java]
        }
        val connection = rule.runOnIdle {
            requireNotNull(rule.activity.currentFocus?.onCreateInputConnection(EditorInfo()))
        }
        rule.runOnIdle { check(connection.setComposingText("とうきょう としょかん", 1)) }
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) {
            model.uiState.value.composing && model.uiState.value.query == "とうきょう としょかん"
        }
        rule.onAllNodes(resultButton).assertCountEquals(0)
        capture("search-composing")
        rule.runOnIdle { check(connection.finishComposingText()) }
        rule.waitUntil(SEARCH_TIMEOUT_MILLIS) { !model.uiState.value.composing }
    }

    private fun expandLibrary() {
        val list = rule.onNode(hasScrollToIndexAction())
        list.performScrollToNode(hasText("図書館の続きを表示"))
        rule
            .onNodeWithText("図書館の続きを表示")
            .assert(buttonRole)
            .assertHeightIsAtLeast(48.dp)
            .performClick()
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
        rule.runOnIdle {
            val dark =
                rule.activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
                    Configuration.UI_MODE_NIGHT_YES
            val bars =
                WindowCompat.getInsetsController(
                    rule.activity.window,
                    rule.activity.window.decorView,
                )
            check(bars.isAppearanceLightStatusBars == !dark) {
                "Status bar appearance differs from the theme: $name"
            }
            check(bars.isAppearanceLightNavigationBars == !dark) {
                "Navigation bar appearance differs from the theme: $name"
            }
        }
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
        assertReadableText()
    }

    private fun assertReadableText() {
        val textNodes =
            rule
                .onAllNodes(
                    SemanticsMatcher.keyIsDefined(SemanticsProperties.Text) and
                        SemanticsMatcher.keyIsDefined(SemanticsActions.GetTextLayoutResult),
                    useUnmergedTree = true,
                )
                .fetchSemanticsNodes()
        textNodes.forEach { node ->
            val layouts = mutableListOf<TextLayoutResult>()
            rule.runOnIdle {
                check(
                    requireNotNull(node.config[SemanticsActions.GetTextLayoutResult].action)(
                        layouts,
                    ),
                )
            }
            layouts.forEach { layout ->
                val wideLine =
                    (0 until layout.lineCount).any { line ->
                        ceil(layout.getLineRight(line) - layout.getLineLeft(line)) >
                            layout.size.width
                    }
                check(!layout.didOverflowHeight && !wideLine) {
                    "Clipped text: ${node.config[SemanticsProperties.Text]}; size=${layout.size}; " +
                        "constraints=${layout.layoutInput.constraints}; lines=${layout.lineCount}; " +
                        "paragraphWidth=${layout.multiParagraph.width}; " +
                        "lineWidths=${(0 until layout.lineCount).map { layout.getLineRight(it) - layout.getLineLeft(it) }}"
                }
            }
        }
    }

    companion object {
        private val resultButton = hasTestTag("search-result")
        private val buttonRole = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button)
        private const val PREPARATION_TIMEOUT_MILLIS = 180_000L
        private const val SEARCH_TIMEOUT_MILLIS = 30_000L
        private const val PNG_QUALITY = 100
        private const val ACCESSIBILITY_IDLE_MILLIS = 500L
        private const val SCREENSHOT_TIMEOUT_MILLIS = 5000L
    }
}
