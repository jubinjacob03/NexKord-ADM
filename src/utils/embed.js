import { 
    MessageFlags, 
    ContainerBuilder, 
    TextDisplayBuilder, 
    SeparatorBuilder, 
    SeparatorSpacingSize 
} from "discord.js";

export const EMBED_COLOR = 0x00ffff;
export const EPHEMERAL_COLOR = 0x2b2d31;

/**
 * Constructs a standardized Discord Components V2 Container with a themed accent color and footer.
 * 
 * @param {string} title - The title header of the container card.
 * @param {string|null} [description=null] - The markdown body content of the container card.
 * @param {number} [color=EMBED_COLOR] - The hexadecimal color code for the accent border.
 * @returns {import('discord.js').ContainerBuilder} The constructed container payload.
 */
export function buildV2Container(title, description = null, color = EMBED_COLOR) {
    const container = new ContainerBuilder().setAccentColor(color);

    let bodyContent = "";
    if (title) bodyContent += `### ${title}\n`;
    if (description) {
        bodyContent += description.trim();
    }
    bodyContent = bodyContent.trim();

    if (bodyContent) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyContent));
    }

    const ts = Math.floor(Date.now() / 1000);
    if (bodyContent) {
        container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        );
    }
    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# NexKord-ADM · <t:${ts}:f>`)
    );

    return container;
}

/**
 * Creates an ephemeral message reply payload wrapping a themed container card.
 * 
 * @param {string} title - The title header of the container card.
 * @param {string|null} [description=null] - The markdown body content of the container card.
 * @returns {import('discord.js').InteractionReplyOptions} The formatted ephemeral interaction reply payload.
 */
export function eReply(title, description = null) {
    return {
        components: [buildV2Container(title, description, EPHEMERAL_COLOR)],
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    };
}
